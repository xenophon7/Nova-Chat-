/*
 * NovaChat — serveur avec base de données SQLite (better-sqlite3)
 * -----------------------------------------------------------------
 * Ce fichier remplace la version qui stockait tout dans des fichiers
 * JSON. La logique des routes est la même que server.js (avec les
 * correctifs de sécurité : limitation des tentatives de connexion,
 * mot de passe admin aléatoire à la première exécution, et vérification
 * du contenu réel des fichiers envoyés).
 *
 * Installation :
 *   npm install better-sqlite3
 *
 * Démarrage : node server.sqlite.js
 * La base est créée automatiquement dans ./novachat.db au premier lancement.
 */
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const Database=require('better-sqlite3');
const game=require('./gameserver');

const PORT=Number(process.env.PORT||8080),HOST='0.0.0.0',APP=__dirname,ROOT=process.env.DATA_DIR||__dirname;
const MAX_VIDEO_BYTES=60*1024*1024,MAX_BODY_BYTES=90*1024*1024,SESSION_MS=30*24*60*60*1000,ONLINE_MS=90*1000;

fs.mkdirSync(ROOT,{recursive:true});
const db=new Database(path.join(ROOT,'novachat.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  salt TEXT NOT NULL,
  passwordHash TEXT NOT NULL,
  profilePhoto TEXT,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY,
  "from" TEXT NOT NULL,
  fromName TEXT,
  "to" TEXT NOT NULL,
  toName TEXT,
  text TEXT,
  type TEXT,
  mediaUrl TEXT,
  mime TEXT,
  createdAt INTEGER NOT NULL,
  deletedEverywhere INTEGER DEFAULT 0,
  deletedFor TEXT DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages("from");
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages("to");
CREATE TABLE IF NOT EXISTS blocks(
  a TEXT NOT NULL, b TEXT NOT NULL, createdAt INTEGER NOT NULL,
  PRIMARY KEY(a,b)
);
CREATE TABLE IF NOT EXISTS admin_blocks(
  userId TEXT PRIMARY KEY, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications(
  id TEXT PRIMARY KEY, "to" TEXT NOT NULL, fromId TEXT, fromName TEXT,
  createdAt INTEGER NOT NULL, read INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS admin(
  id INTEGER PRIMARY KEY CHECK(id=1),
  salt TEXT NOT NULL, passwordHash TEXT NOT NULL,
  createdAt INTEGER, updatedAt INTEGER, mustChange INTEGER DEFAULT 1
);
`);

const sessions=new Map(),adminSessions=new Map(),sessionActivity=new Map();
const loginAttempts=new Map();
const RATE_WINDOW_MS=10*60*1000,RATE_MAX=8,RATE_BLOCK_MS=15*60*1000;
function clientKey(req){return (req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim()}
function checkRate(key){const now=Date.now();const r=loginAttempts.get(key);if(!r)return{blocked:false};if(r.blockedUntil&&r.blockedUntil>now)return{blocked:true,retryAfter:Math.ceil((r.blockedUntil-now)/1000)};if(r.blockedUntil&&r.blockedUntil<=now){loginAttempts.delete(key);return{blocked:false}}if(now-r.firstAt>RATE_WINDOW_MS){loginAttempts.delete(key);return{blocked:false}}return{blocked:false}}
function registerFailure(key){const now=Date.now();const r=loginAttempts.get(key);if(!r||now-r.firstAt>RATE_WINDOW_MS){loginAttempts.set(key,{count:1,firstAt:now,blockedUntil:0});return}r.count++;if(r.count>=RATE_MAX)r.blockedUntil=now+RATE_BLOCK_MS;loginAttempts.set(key,r)}
function registerSuccess(key){loginAttempts.delete(key)}

const uid=()=>crypto.randomBytes(16).toString('hex'),salt=()=>crypto.randomBytes(16).toString('hex'),hash=(p,s)=>crypto.scryptSync(String(p),String(s),64).toString('hex');
const safeEqual=(a,b)=>{try{const x=Buffer.from(String(a),'hex'),y=Buffer.from(String(b),'hex');return x.length===y.length&&crypto.timingSafeEqual(x,y)}catch{return false}};

function ensureFiles(){
  for(const d of ['profiles','media'])if(!fs.existsSync(path.join(ROOT,d)))fs.mkdirSync(path.join(ROOT,d),{recursive:true});
  const row=db.prepare('SELECT * FROM admin WHERE id=1').get();
  if(!row){
    const s=salt();
    const initial=process.env.ADMIN_INITIAL_PASSWORD||crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g,'').slice(0,12);
    db.prepare('INSERT INTO admin(id,salt,passwordHash,createdAt,mustChange) VALUES(1,?,?,?,1)').run(s,hash(initial,s),Date.now());
    console.log('========================================');
    console.log('Compte admin créé. Mot de passe initial : '+initial);
    console.log('Ce mot de passe doit être changé dès la première connexion.');
    console.log('========================================');
  }
}

function cookies(req){const out={};for(const p of (req.headers.cookie||'').split(';')){if(!p.trim())continue;const i=p.indexOf('=');if(i<0)continue;const k=p.slice(0,i).trim(),v=p.slice(i+1).trim();try{out[k]=decodeURIComponent(v)}catch{out[k]=v}}return out}
function cookie(name,token,req,max=SESSION_MS){const secure=req.headers['x-forwarded-proto']==='https'||process.env.RENDER==='true'?' Secure;':'';return `${name}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(max/1000)};${secure}`}
function clearCookie(name,req){const secure=req.headers['x-forwarded-proto']==='https'||process.env.RENDER==='true'?' Secure;':'';return `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax;${secure}`}

function me(req){
  const t=cookies(req).nova_session||req.headers['x-token'];if(!t)return null;
  const id=sessions.get(t);if(!id)return null;
  if(adminBlocked(id)){sessions.delete(t);sessionActivity.delete(t);return null}
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if(!u){sessions.delete(t);sessionActivity.delete(t);return null}
  sessionActivity.set(t,Date.now());
  return u;
}
function adminMe(req){const c=cookies(req);const t=c.nova_admin||String(req.headers['x-admin-token']||'');const v=t&&adminSessions.get(t);if(!v||v.expiresAt<=Date.now()){if(t&&adminSessions.has(t))adminSessions.delete(t);return false}return true}

function body(req,max=MAX_BODY_BYTES){return new Promise((resolve,reject)=>{let s='',done=false;req.on('data',c=>{if(done)return;s+=c.toString();if(Buffer.byteLength(s)>max){done=true;reject(Error('Payload too large'));req.resume()}});req.on('end',()=>{if(!done)resolve(s)});req.on('error',e=>{if(!done){done=true;reject(e)}})})}
async function jsonBody(req,max){return JSON.parse(await body(req,max)||'{}')}
function out(res,n,x,h={}){res.writeHead(n,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...h});res.end(JSON.stringify(x))}

const pub=u=>({id:u.id,name:u.name,profilePhoto:u.profilePhoto||null,createdAt:u.createdAt});
const find=n=>db.prepare('SELECT * FROM users WHERE LOWER(name)=LOWER(?)').get(String(n||'').trim());
const blocked=(a,b)=>!!db.prepare('SELECT 1 FROM blocks WHERE (a=? AND b=?) OR (a=? AND b=?)').get(a,b,b,a);
const adminBlocked=id=>!!db.prepare('SELECT 1 FROM admin_blocks WHERE userId=?').get(id);
const onlineUserIds=()=>{const now=Date.now(),ids=new Set();for(const [token,id] of sessions){const last=sessionActivity.get(token)||0;if(last&&now-last<=ONLINE_MS&&!adminBlocked(id))ids.add(id)}return ids};

function sniffMime(buf){
  const b=buf;
  const starts=(arr,off=0)=>arr.every((v,i)=>b[off+i]===v);
  if(starts([0xFF,0xD8,0xFF]))return 'image/jpeg';
  if(starts([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]))return 'image/png';
  if(starts([0x47,0x49,0x46,0x38]))return 'image/gif';
  if(b.length>=12&&starts([0x52,0x49,0x46,0x46])&&b.slice(8,12).toString('ascii')==='WEBP')return 'image/webp';
  if(b.length>=12&&starts([0x52,0x49,0x46,0x46])&&b.slice(8,12).toString('ascii')==='WAVE')return 'audio/wav';
  if(starts([0x4F,0x67,0x67,0x53]))return 'audio/ogg';
  if(starts([0x49,0x44,0x33])||starts([0xFF,0xFB])||starts([0xFF,0xF3])||starts([0xFF,0xF2]))return 'audio/mpeg';
  if(starts([0x1A,0x45,0xDF,0xA3]))return 'webm';
  if(b.length>=12&&b.slice(4,8).toString('ascii')==='ftyp'){
    const brand=b.slice(8,12).toString('ascii');
    if(/^(M4A |M4B )/.test(brand))return 'audio/mp4';
    if(/^(qt  )/.test(brand))return 'video/quicktime';
    return 'video/mp4';
  }
  return null;
}
function sniffKind(mime){
  if(!mime)return null;
  if(mime==='webm')return 'webm';
  if(mime.startsWith('image/'))return 'image';
  if(mime.startsWith('audio/'))return 'audio';
  if(mime.startsWith('video/'))return 'video';
  return null;
}

async function api(req,res,u){
 if(req.method==='POST'&&(u.pathname==='/api/register'||u.pathname==='/api/login')){
   const rateKey='login:'+clientKey(req);const rl=checkRate(rateKey);
   if(rl.blocked)return out(res,429,{error:'Trop de tentatives. Réessayez dans '+Math.ceil(rl.retryAfter/60)+' minute(s).'});
   let d;try{d=await jsonBody(req,1e5)}catch{return out(res,400,{error:'Données invalides'})}
   const name=String(d.name||'').trim().slice(0,30),p=String(d.password||'');
   if(!name||p.length<4)return out(res,400,{error:'Nom et mot de passe requis (mot de passe : 4 caractères minimum)'});
   let x=find(name);
   if(u.pathname==='/api/register'){
     if(x){registerFailure(rateKey);return out(res,409,{error:'Ce nom existe déjà'})}
     const s=salt();
     x={id:uid(),name,salt:s,passwordHash:hash(p,s),createdAt:Date.now(),profilePhoto:null};
     db.prepare('INSERT INTO users(id,name,salt,passwordHash,profilePhoto,createdAt) VALUES(?,?,?,?,?,?)')
       .run(x.id,x.name,x.salt,x.passwordHash,x.profilePhoto,x.createdAt);
   }else if(!x||!safeEqual(hash(p,x.salt),x.passwordHash)){
     registerFailure(rateKey);return out(res,401,{error:'Nom ou mot de passe incorrect'});
   }else if(adminBlocked(x.id))return out(res,403,{error:'Compte bloqué par l\u2019administrateur'});
   registerSuccess(rateKey);
   const t=uid();sessions.set(t,x.id);sessionActivity.set(t,Date.now());
   return out(res,200,{ok:true,user:pub(x)},{'Set-Cookie':cookie('nova_session',t,req)});
 }
 if(req.method==='POST'&&u.pathname==='/api/logout'){const t=cookies(req).nova_session||req.headers['x-token'];if(t){sessions.delete(t);sessionActivity.delete(t)}return out(res,200,{ok:true},{'Set-Cookie':clearCookie('nova_session',req)})}
 if(req.method==='GET'&&u.pathname==='/api/health'){
   const usersCount=db.prepare('SELECT COUNT(*) c FROM users').get().c;
   const msgsCount=db.prepare('SELECT COUNT(*) c FROM messages').get().c;
   return out(res,200,{ok:true,users:usersCount,messages:msgsCount,sessions:sessions.size,onlineCount:onlineUserIds().size});
 }
 if(req.method==='POST'&&u.pathname==='/api/admin/login'){
   const rateKey='admin:'+clientKey(req);const rl=checkRate(rateKey);
   if(rl.blocked)return out(res,429,{error:'Trop de tentatives. Réessayez dans '+Math.ceil(rl.retryAfter/60)+' minute(s).'});
   let d;try{d=await jsonBody(req,1e5)}catch{return out(res,400,{error:'Données invalides'})}
   const cfg=db.prepare('SELECT * FROM admin WHERE id=1').get();
   if(!cfg||!safeEqual(hash(String(d.password||''),cfg.salt),cfg.passwordHash)){registerFailure(rateKey);return out(res,401,{error:'Mot de passe admin incorrect'})}
   registerSuccess(rateKey);
   const t=uid();adminSessions.set(t,{expiresAt:Date.now()+SESSION_MS});
   return out(res,200,{ok:true,authenticated:true,adminToken:t,mustChangePassword:!!cfg.mustChange},{'Set-Cookie':cookie('nova_admin',t,req)});
 }
 if(req.method==='POST'&&u.pathname==='/api/admin/logout'){const t=cookies(req).nova_admin;if(t)adminSessions.delete(t);return out(res,200,{ok:true},{'Set-Cookie':clearCookie('nova_admin',req)})}
 if(req.method==='GET'&&u.pathname==='/api/admin/me'){const a=adminMe(req);return out(res,200,{ok:a,authenticated:a})}
 if(req.method==='GET'&&u.pathname==='/api/admin/stats'){
   if(!adminMe(req))return out(res,401,{error:'ADMIN_AUTH_REQUIRED'});
   const users=db.prepare('SELECT * FROM users').all();
   const msgs=db.prepare('SELECT * FROM messages ORDER BY createdAt DESC LIMIT 300').all();
   const onlineIds=onlineUserIds();
   let media=0;try{media=fs.readdirSync(path.join(ROOT,'media')).length}catch{}
   const pairs={};
   msgs.forEach(m=>{
     const ids=[m.from,m.to].sort();const k=ids.join('::');
     if(!pairs[k]){
       const ua=users.find(v=>v.id===ids[0]),ub=users.find(v=>v.id===ids[1]);
       pairs[k]={from:ids[0],to:ids[1],count:0,fromName:ua?.name||m.fromName,toName:ub?.name||m.toName,conversation:(ua?.name||m.fromName)+' ↔ '+(ub?.name||m.toName)};
     }
     pairs[k].count++;
   });
   return out(res,200,{
     playing:game.presence(),
     users:users.map(v=>({...pub(v),adminBlocked:adminBlocked(v.id),online:onlineIds.has(v.id)})),
     stats:{users:users.length,messages:msgs.length,activeSessions:onlineIds.size,mediaFiles:media,conversations:Object.values(pairs)},
     activeUserIds:[...onlineIds],conversations:Object.values(pairs)
   });
 }
 if(req.method==='GET'&&u.pathname==='/api/admin/all-messages'){
   if(!adminMe(req))return out(res,401,{error:'ADMIN_AUTH_REQUIRED'});
   const users=db.prepare('SELECT * FROM users').all();
   const byId=new Map(users.map(v=>[v.id,v]));
   const msgs=db.prepare('SELECT * FROM messages ORDER BY createdAt ASC').all();
   const enriched=msgs.map(m=>{
     const from=byId.get(m.from),to=byId.get(m.to);
     return {...m,fromName:from?.name||m.fromName||m.from,toName:to?.name||m.toName||m.to,
       fromUser:from?pub(from):null,toUser:to?pub(to):null,
       mediaAvailable:!!(m.mediaUrl&&fs.existsSync(path.resolve(ROOT,String(m.mediaUrl).replace(/^\/+/,''))))};
   });
   return out(res,200,{messages:enriched,count:enriched.length});
 }
 if(req.method==='GET'&&(u.pathname==='/api/admin/conversation'||u.pathname==='/api/admin/messages')){
   if(!adminMe(req))return out(res,401,{error:'ADMIN_AUTH_REQUIRED'});
   let a=u.searchParams.get('a')||u.searchParams.get('from'),b=u.searchParams.get('b')||u.searchParams.get('to');
   const resolve=v=>{if(!v)return null;return db.prepare('SELECT * FROM users WHERE id=? OR LOWER(name)=LOWER(?)').get(v,v)||null};
   const ua=resolve(a),ub=resolve(b);
   if(!ua||!ub)return out(res,404,{error:'Participants introuvables'});
   const messages=db.prepare('SELECT * FROM messages WHERE ("from"=? AND "to"=?) OR ("from"=? AND "to"=?) ORDER BY createdAt ASC').all(ua.id,ub.id,ub.id,ua.id);
   return out(res,200,{messages,participants:{a:pub(ua),b:pub(ub)}});
 }
 if(req.method==='POST'&&u.pathname==='/api/admin/delete-user'){
   if(!adminMe(req))return out(res,401,{error:'ADMIN_AUTH_REQUIRED'});
   let d;try{d=await jsonBody(req,1e5)}catch{return out(res,400,{error:'Données invalides'})}
   const cfg=db.prepare('SELECT * FROM admin WHERE id=1').get();
   if(!d.adminPassword||!cfg||!safeEqual(hash(String(d.adminPassword),cfg.salt),cfg.passwordHash))return out(res,403,{error:'ADMIN_PASSWORD_REQUIRED'});
   const target=db.prepare('SELECT * FROM users WHERE id=? OR LOWER(name)=LOWER(?)').get(String(d.userId||''),String(d.name||'').trim());
   if(!target)return out(res,404,{error:'Utilisateur introuvable'});
   const id=target.id;
   const related=db.prepare('SELECT * FROM messages WHERE "from"=? OR "to"=?').all(id,id);
   let deletedMedia=0;
   for(const m of related){
     if(m.mediaUrl){
       const rel=String(m.mediaUrl).split('?')[0].replace(/^\//,'');
       const file=path.resolve(ROOT,rel);
       if(file.startsWith(path.resolve(ROOT,'media')+path.sep)){try{if(fs.existsSync(file)){fs.unlinkSync(file);deletedMedia++}}catch{}}
     }
   }
   if(target.profilePhoto){
     const rel=String(target.profilePhoto).split('?')[0].replace(/^\//,'');
     const file=path.resolve(ROOT,rel);
     if(file.startsWith(path.resolve(ROOT,'profiles')+path.sep)){try{if(fs.existsSync(file))fs.unlinkSync(file)}catch{}}
   }
   db.prepare('DELETE FROM users WHERE id=?').run(id);
   db.prepare('DELETE FROM messages WHERE "from"=? OR "to"=?').run(id,id);
   db.prepare('DELETE FROM blocks WHERE a=? OR b=?').run(id,id);
   db.prepare('DELETE FROM notifications WHERE "to"=? OR fromId=?').run(id,id);
   db.prepare('DELETE FROM admin_blocks WHERE userId=?').run(id);
   for(const [t,uidv] of [...sessions])if(uidv===id){sessions.delete(t);sessionActivity.delete(t)}
   return out(res,200,{ok:true,deletedUser:{id,name:target.name},deletedMessages:related.length,deletedMedia});
 }
 if(req.method==='POST'&&u.pathname==='/api/admin/delete-media'){
   if(!adminMe(req))return out(res,401,{error:'ADMIN_AUTH_REQUIRED'});
   let deleted=0;const dir=path.join(ROOT,'media');
   try{for(const name of fs.readdirSync(dir)){const file=path.join(dir,name);try{if(fs.statSync(file).isFile()){fs.unlinkSync(file);deleted++}}catch{}}}catch{}
   const info=db.prepare("UPDATE messages SET mediaUrl=NULL, mime=NULL, type=CASE WHEN type!='deleted' THEN 'text' ELSE type END WHERE mediaUrl IS NOT NULL").run();
   return out(res,200,{ok:true,deletedMedia:deleted,updatedMessages:info.changes});
 }
 if(req.method==='POST'&&u.pathname==='/api/admin/block'){
   if(!adminMe(req))return out(res,401,{error:'ADMIN_AUTH_REQUIRED'});
   let d;try{d=await jsonBody(req,1e5)}catch{return out(res,400,{error:'Données invalides'})}
   const target=db.prepare('SELECT * FROM users WHERE id=? OR LOWER(name)=LOWER(?)').get(String(d.userId||''),String(d.name||''));
   if(!target)return out(res,404,{error:'Utilisateur introuvable'});
   const id=target.id;
   db.prepare('DELETE FROM admin_blocks WHERE userId=?').run(id);
   if(d.block!==false)db.prepare('INSERT INTO admin_blocks(userId,createdAt) VALUES(?,?)').run(id,Date.now());
   if(d.block!==false){for(const [t,uidv] of [...sessions])if(uidv===id){sessions.delete(t);sessionActivity.delete(t)}}
   return out(res,200,{ok:true,blocked:adminBlocked(id)});
 }
 if(req.method==='POST'&&u.pathname==='/api/admin/password'){
   if(!adminMe(req))return out(res,401,{error:'Accès admin requis'});
   let d;try{d=await jsonBody(req,1e5)}catch{return out(res,400,{error:'Données invalides'})}
   const cfg=db.prepare('SELECT * FROM admin WHERE id=1').get();
   const old=String(d.currentPassword??d.current??''),nw=String(d.newPassword??d.next??'');
   if(!cfg||!safeEqual(hash(old,cfg.salt),cfg.passwordHash))return out(res,403,{error:'Mot de passe actuel incorrect'});
   if(nw.length<4)return out(res,400,{error:'Le nouveau mot de passe doit contenir au moins 4 caractères'});
   const s=salt();
   db.prepare('UPDATE admin SET salt=?, passwordHash=?, updatedAt=?, mustChange=0 WHERE id=1').run(s,hash(nw,s),Date.now());
   return out(res,200,{ok:true});
 }
 const x=me(req);if(u.pathname.startsWith('/api/')&&!x)return out(res,401,{error:'Non connecté'});
 if(req.method==='GET'&&u.pathname==='/api/me')return out(res,200,{user:pub(x)});
 if(req.method==='POST'&&u.pathname==='/api/profile/password'){
   let d;try{d=await jsonBody(req,1e5)}catch{return out(res,400,{error:'Données invalides'})}
   const current=String(d.currentPassword||''),next=String(d.newPassword||'');
   if(!current||!next)return out(res,400,{error:'Mot de passe actuel et nouveau mot de passe requis'});
   if(next.length<4)return out(res,400,{error:'Le nouveau mot de passe doit contenir au moins 4 caractères'});
   const v=db.prepare('SELECT * FROM users WHERE id=?').get(x.id);
   if(!v||!safeEqual(hash(current,v.salt),v.passwordHash))return out(res,403,{error:'Mot de passe actuel incorrect'});
   const s=salt();
   db.prepare('UPDATE users SET salt=?, passwordHash=? WHERE id=?').run(s,hash(next,s),x.id);
   return out(res,200,{ok:true});
 }
 if(req.method==='POST'&&u.pathname==='/api/profile/name'){
   let d;try{d=await jsonBody(req,1e5)}catch{return out(res,400,{error:'Données invalides'})}
   const name=String(d.name||'').trim().slice(0,30);
   if(!/^[\p{L}0-9 _.-]{2,30}$/u.test(name))return out(res,400,{error:'Nom invalide (2 à 30 caractères)'});
   const e=find(name);if(e&&e.id!==x.id)return out(res,409,{error:'Ce nom existe déjà'});
   db.prepare('UPDATE users SET name=? WHERE id=?').run(name,x.id);
   db.prepare('UPDATE messages SET fromName=? WHERE "from"=?').run(name,x.id);
   db.prepare('UPDATE messages SET toName=? WHERE "to"=?').run(name,x.id);
   x.name=name;
   return out(res,200,{ok:true,user:pub(x)});
 }
 if(req.method==='GET'&&u.pathname==='/api/user'){const o=find(u.searchParams.get('name'));if(!o)return out(res,404,{error:'Utilisateur introuvable'});return out(res,200,pub(o))}
 if(req.method==='GET'&&u.pathname==='/api/users'){
   const q=String(u.searchParams.get('q')||'').toLowerCase();
   const online=onlineUserIds();
   const all=db.prepare('SELECT * FROM users').all().filter(v=>v.id!==x.id&&String(v.name||'').toLowerCase().includes(q)).slice(0,50);
   return out(res,200,{onlineCount:online.size,otherOnlineCount:[...online].filter(id=>id!==x.id).length,
     users:all.map(v=>({...pub(v),online:online.has(v.id),blocked:blocked(x.id,v.id)}))});
 }
 if(req.method==='GET'&&u.pathname==='/api/block/status'){const o=find(u.searchParams.get('name'));if(!o)return out(res,404,{error:'Utilisateur introuvable'});return out(res,200,{blocked:blocked(x.id,o.id)})}
 if(req.method==='GET'&&u.pathname==='/api/messages'){
   const o=find(u.searchParams.get('with'));if(!o)return out(res,404,{error:'Utilisateur introuvable'});
   if(blocked(x.id,o.id))return out(res,200,{messages:[],blocked:true});
   const rows=db.prepare('SELECT * FROM messages WHERE (("from"=? AND "to"=?) OR ("from"=? AND "to"=?)) ORDER BY createdAt ASC').all(x.id,o.id,o.id,x.id);
   const visible=rows.filter(m=>!JSON.parse(m.deletedFor||'[]').includes(x.id)).slice(-300);
   return out(res,200,{messages:visible,blocked:false});
 }
 if(req.method==='POST'&&u.pathname==='/api/send'){
   let d;try{d=await jsonBody(req,MAX_BODY_BYTES)}catch{return out(res,400,{error:'Données invalides ou trop volumineuses'})}
   const to=find(d.to);if(!to)return out(res,404,{error:'Utilisateur introuvable'});
   if(blocked(x.id,to.id))return out(res,403,{error:'Conversation bloquée'});
   const m={id:uid(),from:x.id,fromName:x.name,to:to.id,toName:to.name,text:String(d.text||'').slice(0,5000),type:'text',mediaUrl:null,mime:null,createdAt:Date.now()};
   if(d.media&&String(d.media.data||'').startsWith('data:')){
     const raw=String(d.media.data),approx=Math.floor(raw.length*3/4),inputMime=String(d.media.mime||'').toLowerCase();
     if(inputMime.startsWith('video/')&&approx>MAX_VIDEO_BYTES)return out(res,413,{error:'Vidéo trop volumineuse (60 Mo maximum)'});
     if(!inputMime.startsWith('image/')&&!inputMime.startsWith('audio/')&&!inputMime.startsWith('video/'))return out(res,415,{error:'Type de média non autorisé'});
     const z=raw.match(/^data:([^,]*?);base64,(.+)$/s);if(!z)return out(res,400,{error:'Média invalide'});
     const mime=z[1].toLowerCase().split(';')[0].trim();
     const map={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','audio/webm':'weba','audio/ogg':'oga','audio/mp4':'m4a','audio/wav':'wav','audio/wave':'wav','audio/x-wav':'wav','audio/mpeg':'mp3','audio/mp3':'mp3','audio/aac':'aac','audio/x-m4a':'m4a','video/mp4':'mp4','video/webm':'webm','video/ogg':'ogv','video/quicktime':'mov'};
     if(!map[mime])return out(res,415,{error:'Type de média non autorisé'});
     const buf=Buffer.from(z[2],'base64');if(!buf.length)return out(res,400,{error:'Média vide'});
     const sniffed=sniffMime(buf);const declaredKind=sniffKind(mime);const actualKind=sniffed==='webm'?declaredKind:sniffKind(sniffed);
     if(!sniffed||actualKind!==declaredKind)return out(res,415,{error:'Le contenu du fichier ne correspond pas au type déclaré'});
     const ext=map[mime],fn=m.id+'.'+ext;
     fs.writeFileSync(path.join(ROOT,'media',fn),buf);
     m.type=mime.startsWith('audio/')?'audio':mime.startsWith('video/')?'video':'image';
     m.mediaUrl='/media/'+fn;m.mime=mime;
   }
   db.prepare('INSERT INTO messages(id,"from",fromName,"to",toName,text,type,mediaUrl,mime,createdAt,deletedFor) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
     .run(m.id,m.from,m.fromName,m.to,m.toName,m.text,m.type,m.mediaUrl,m.mime,m.createdAt,'[]');
   db.prepare('INSERT INTO notifications(id,"to",fromId,fromName,createdAt,read) VALUES(?,?,?,?,?,0)')
     .run(uid(),to.id,x.id,x.name,Date.now());
   return out(res,200,{ok:true,message:m});
 }
 if(req.method==='POST'&&u.pathname==='/api/delete'){
   let d;try{d=await jsonBody(req,1e5)}catch{return out(res,400,{error:'Données invalides'})}
   const m=db.prepare('SELECT * FROM messages WHERE id=?').get(String(d.id||''));
   if(!m)return out(res,404,{error:'Message introuvable'});
   if(m.from!==x.id&&m.to!==x.id)return out(res,403,{error:'Accès refusé'});
   if(d.mode==='everyone'){
     if(m.from!==x.id)return out(res,403,{error:'Seul l\u2019auteur peut supprimer pour tout le monde'});
     db.prepare("UPDATE messages SET text=?, type='deleted', mediaUrl=NULL, mime=NULL, deletedFor='[]', deletedEverywhere=1 WHERE id=?").run('Message supprimé',m.id);
   }else{
     const list=new Set(JSON.parse(m.deletedFor||'[]'));list.add(x.id);
     db.prepare('UPDATE messages SET deletedFor=? WHERE id=?').run(JSON.stringify([...list]),m.id);
   }
   return out(res,200,{ok:true});
 }
 if(req.method==='POST'&&u.pathname==='/api/game/invite'){
   let d;try{d=await jsonBody(req,1e5)}catch{return out(res,400,{error:'Données invalides'})}
   const to=find(d.to);if(!to)return out(res,404,{error:'Utilisateur introuvable'});
   const code=String(d.room||'').toUpperCase();
   if(!game.hasRoom(code))return out(res,404,{error:'Ce salon n\u2019existe plus'});
   if(blocked(x.id,to.id))return out(res,403,{error:'Conversation bloquée'});
   const m={id:uid(),from:x.id,fromName:x.name,to:to.id,toName:to.name,type:'text',createdAt:Date.now(),
     text:'🎮 '+x.name+' t\u2019invite à jouer à Energy Arena !\nCode : '+code+'\n👉 Touche ce message pour rejoindre la partie.'};
   db.prepare('INSERT INTO messages(id,"from",fromName,"to",toName,text,type,mediaUrl,mime,createdAt,deletedFor) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(m.id,m.from,m.fromName,m.to,m.toName,m.text,m.type,null,null,m.createdAt,'[]');
   db.prepare('INSERT INTO notifications(id,"to",fromId,fromName,createdAt,read) VALUES(?,?,?,?,?,0)').run(uid(),to.id,x.id,x.name,Date.now());
   return out(res,200,{ok:true});
 }
 if(req.method==='POST'&&u.pathname==='/api/block'){
   let d;try{d=await jsonBody(req,1e5)}catch{return out(res,400,{error:'Données invalides'})}
   const o=find(d.name);if(!o)return out(res,404,{error:'Utilisateur introuvable'});
   db.prepare('DELETE FROM blocks WHERE a=? AND b=?').run(x.id,o.id);
   if(d.block!==false)db.prepare('INSERT INTO blocks(a,b,createdAt) VALUES(?,?,?)').run(x.id,o.id,Date.now());
   return out(res,200,{ok:true,blocked:blocked(x.id,o.id)});
 }
 if(req.method==='GET'&&u.pathname==='/api/notifications'){
   const rows=db.prepare('SELECT * FROM notifications WHERE "to"=? ORDER BY createdAt DESC LIMIT 100').all(x.id);
   return out(res,200,{notifications:rows});
 }
 if(req.method==='POST'&&u.pathname==='/api/notifications/read'){db.prepare('UPDATE notifications SET read=1 WHERE "to"=?').run(x.id);return out(res,200,{ok:true})}
 if(req.method==='POST'&&u.pathname==='/api/profile/photo'){
   let d;try{d=await jsonBody(req,12e6)}catch{return out(res,400,{error:'Image trop volumineuse ou données invalides'})}
   const z=String(d.data||'').match(/^data:image\/([^;]+);base64,(.+)$/s);
   if(!z)return out(res,400,{error:'Image invalide'});
   const buf=Buffer.from(z[2],'base64');
   const sniffed=sniffMime(buf);
   if(!sniffed||sniffKind(sniffed)!=='image')return out(res,415,{error:'Le contenu du fichier ne correspond pas à une image'});
   const ext=z[1].replace(/[^a-z0-9]/gi,'').toLowerCase()||'png',fn=x.id+'.'+ext;
   fs.writeFileSync(path.join(ROOT,'profiles',fn),buf);
   const photoUrl='/profiles/'+fn+'?v='+Date.now();
   db.prepare('UPDATE users SET profilePhoto=? WHERE id=?').run(photoUrl,x.id);
   x.profilePhoto=photoUrl;
   return out(res,200,{profilePhoto:x.profilePhoto});
 }
 return out(res,404,{error:'Route introuvable'});
}

function staticFile(res,p){
  const root=path.resolve(APP,'public'),file=path.resolve(root,'.'+(p==='/'?'/index.html':p));
  if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403);return res.end('Forbidden')}
  fs.readFile(file,(e,b)=>{
    if(e){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Not found')}
    const ext=path.extname(file).toLowerCase();
    const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml'};
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-store'});
    res.end(b);
  });
}
function mediaFile(req,res,p){
  const root=path.resolve(ROOT),file=path.resolve(root,p.replace(/^\/+/,''));
  if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403);return res.end('Forbidden')}
  fs.stat(file,(e,s)=>{
    if(e||!s.isFile()){res.writeHead(404);return res.end('Not found')}
    const types={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.webm':'video/webm','.weba':'audio/webm','.mp4':'video/mp4','.ogv':'video/ogg','.mov':'video/quicktime','.m4a':'audio/mp4','.wav':'audio/wav','.oga':'audio/ogg','.ogg':'audio/ogg'};
    const mime=types[path.extname(file).toLowerCase()]||'application/octet-stream';
    const size=s.size;const range=req.headers.range;
    if(!range){res.writeHead(200,{'Content-Type':mime,'Content-Length':size,'Accept-Ranges':'bytes','Cache-Control':'public, max-age=31536000'});return fs.createReadStream(file).pipe(res)}
    const m=range.match(/bytes=(\\d*)-(\\d*)/);
    if(!m){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end()}
    let start=m[1]===''?0:Number(m[1]);let end=m[2]===''?size-1:Number(m[2]);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end()}
    end=Math.min(end,size-1);const len=end-start+1;
    res.writeHead(206,{'Content-Type':mime,'Content-Length':len,'Content-Range':`bytes ${start}-${end}/${size}`,'Accept-Ranges':'bytes','Cache-Control':'public, max-age=31536000'});
    fs.createReadStream(file,{start,end}).pipe(res);
  });
}

if(process.env.RENDER&&!process.env.DATA_DIR)console.warn('⚠️ ATTENTION : DATA_DIR non défini. Sur Render, les données seront EFFACÉES à chaque redémarrage. Voir LISEZMOI.txt.');
console.log('Dossier des données :',ROOT);
ensureFiles();
const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(u.pathname==='/admin')u.pathname='/admin.html';
    if(u.pathname.startsWith('/api/'))return await api(req,res,u);
    if(u.pathname.startsWith('/media/')||u.pathname.startsWith('/profiles/'))return mediaFile(req,res,u.pathname);
    return staticFile(res,u.pathname);
  }catch(e){
    console.error(e);
    if(!res.headersSent)out(res,500,{error:'Erreur serveur'});else res.end();
  }
});
game.attach(server,{auth:me});
server.listen(PORT,HOST,()=>{
  console.log(`NovaChat (SQLite) sur http://${HOST}:${PORT}`);
  console.log(`Admin : http://localhost:${PORT}/admin`);
});
