'use strict';
/* Energy Arena — serveur de parties (WebSocket maison, aucune dépendance) */
const crypto=require('crypto');
const Core=require('./public/game-core.js');

const rooms=new Map(),TICK=50,TTL=20*60*1000;
const MODES={coop:'Coop contre les bots',pvp:'Joueur contre joueur'};
const newCode=()=>crypto.randomBytes(5).toString('hex');
const cleanSkin=s=>({
  color:/^#[0-9a-fA-F]{6}$/.test(String(s&&s.color))?s.color:'#00d4ff',
  eyes:['normal','angry','laser'].includes(s&&s.eyes)?s.eyes:'normal'
});

/* ---------- WebSocket (RFC 6455, texte uniquement) ---------- */
const accept=k=>crypto.createHash('sha1').update(k+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
function frame(str){
  const p=Buffer.from(str),n=p.length;let h;
  if(n<126)h=Buffer.from([0x81,n]);
  else if(n<65536){h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(n,2)}
  else{h=Buffer.alloc(10);h[0]=0x81;h[1]=127;h.writeBigUInt64BE(BigInt(n),2)}
  return Buffer.concat([h,p]);
}
function send(ws,o){
  if(ws.dead)return;
  try{if(ws.socket.writableLength>1e6)return;ws.socket.write(frame(typeof o==='string'?o:JSON.stringify(o)))}catch{}
}
function parse(ws){
  while(ws.buf.length>=2){
    const b0=ws.buf[0],b1=ws.buf[1],fin=b0&0x80,op=b0&0x0f,masked=b1&0x80;
    let len=b1&0x7f,off=2;
    if(len===126){if(ws.buf.length<4)return;len=ws.buf.readUInt16BE(2);off=4}
    else if(len===127){if(ws.buf.length<10)return;const big=ws.buf.readBigUInt64BE(2);if(big>65536n)return kill(ws);len=Number(big);off=10}
    if(len>65536||!masked)return kill(ws);
    if(ws.buf.length<off+4+len)return;
    const mask=ws.buf.slice(off,off+4),payload=Buffer.from(ws.buf.slice(off+4,off+4+len));
    for(let i=0;i<len;i++)payload[i]^=mask[i&3];
    ws.buf=ws.buf.slice(off+4+len);
    if(op===8)return kill(ws);
    if(op===9){try{ws.socket.write(Buffer.concat([Buffer.from([0x8A,Math.min(payload.length,125)]),payload.slice(0,125)]))}catch{}continue}
    if(op===1&&fin)onMsg(ws,payload.toString('utf8'));
    else if(op!==10)return kill(ws);
  }
}
function kill(ws){
  if(ws.dead)return;
  ws.dead=true;leave(ws);
  try{ws.socket.destroy()}catch{}
}

/* ---------- Salles ---------- */
const roster=r=>r.game?[...r.game.players.values()].map(p=>({id:p.id,name:p.name,color:p.color,eyes:p.eyes})):[];
function broadcast(r,o){const s=JSON.stringify(o);for(const ws of r.clients.values())send(ws,s)}
function startLoop(r){
  if(r.timer)return;
  r.timer=setInterval(()=>{
    if(!r.game)return;
    r.game.step(TICK/1000);
    broadcast(r,Object.assign({t:'s'},r.game.snapshot()));
  },TICK);
}
function stopLoop(r){if(r.timer){clearInterval(r.timer);r.timer=null}}
function leave(ws){
  const r=ws.room;if(!r)return;
  ws.room=null;
  if(r.clients.get(ws.user.id)!==ws)return;
  r.clients.delete(ws.user.id);
  if(r.game)r.game.removePlayer(ws.user.id);
  broadcast(r,{t:'roster',players:roster(r)});
  if(!r.clients.size){stopLoop(r);r.emptySince=Date.now()}
}
function closeRoom(r){
  stopLoop(r);
  for(const ws of [...r.clients.values()]){send(ws,{t:'err',m:'Partie fermée'});kill(ws)}
  rooms.delete(r.code);
}
function err(ws,m){send(ws,{t:'err',m})}

function onMsg(ws,str){
  if(str.length>2000)return;
  let m;try{m=JSON.parse(str)}catch{return}
  if(!m||typeof m!=='object')return;
  if(m.t==='join'){
    if(ws.room)return;
    const r=rooms.get(String(m.room||''));
    if(!r||Date.now()-r.createdAt>TTL)return err(ws,'Partie introuvable ou expirée');
    const id=ws.user.id;
    if(id!==r.hostId&&id!==r.guestId)return err(ws,'Cette invitation n’est pas pour ce compte');
    const old=r.clients.get(id);
    if(old){leave(old);old.dead=true;try{old.socket.destroy()}catch{}}
    const skin=cleanSkin(m.skin);
    r.clients.set(id,ws);ws.room=r;r.emptySince=0;
    if(!r.game)r.game=Core.create({mode:r.mode});
    r.game.addPlayer(id,{name:ws.user.name,color:skin.color,eyes:skin.eyes});
    send(ws,{t:'welcome',you:id,room:r.code,mode:r.mode,host:id===r.hostId,
      friend:id===r.hostId?r.guestName:r.hostName,roster:roster(r)});
    broadcast(r,{t:'roster',players:roster(r)});
    startLoop(r);
  }else if(m.t==='in'){
    const r=ws.room;if(!r||!r.game)return;
    const now=Date.now();if(now-ws.lastIn<20)return;ws.lastIn=now;
    r.game.setInput(ws.user.id,m);
  }else if(m.t==='again'){
    const r=ws.room;if(!r||!r.game)return;
    const now=Date.now();if(now-(r.lastAgain||0)<1500)return;r.lastAgain=now;
    if(r.game.phase==='ended'||r.game.phase==='over')r.game.restart();
  }else if(m.t==='leave')kill(ws);
}

function attachWs(server,deps){
  server.on('upgrade',(req,socket)=>{
    try{
      const url=new URL(req.url,'http://x');
      if(url.pathname!=='/ws'||String(req.headers.upgrade||'').toLowerCase()!=='websocket'){socket.destroy();return}
      const origin=req.headers.origin;
      if(origin){let ok=false;try{ok=new URL(origin).host===req.headers.host}catch{}
        if(!ok){socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');socket.destroy();return}}
      const user=deps.me(req);
      if(!user){socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');socket.destroy();return}
      const key=req.headers['sec-websocket-key'];
      if(!key){socket.destroy();return}
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept(key)+'\r\n\r\n');
      socket.setNoDelay(true);
      const ws={socket,user,room:null,buf:Buffer.alloc(0),lastIn:0,dead:false};
      socket.on('data',d=>{ws.buf=Buffer.concat([ws.buf,d]);if(ws.buf.length>200000)return kill(ws);parse(ws)});
      socket.on('close',()=>kill(ws));
      socket.on('error',()=>kill(ws));
    }catch(e){try{socket.destroy()}catch{}}
  });
}

/* ---------- API HTTP : invitations ---------- */
async function api(req,res,u,x,d){
  if(req.method==='POST'&&u.pathname==='/api/game/invite'){
    let b;try{b=await d.jsonBody(req,1e4)}catch{return d.out(res,400,{error:'Données invalides'})}
    const mode=MODES[b.mode]?b.mode:null;
    if(!mode)return d.out(res,400,{error:'Mode invalide'});
    const to=d.find(b.to);
    if(!to||to.id===x.id)return d.out(res,404,{error:'Ami introuvable'});
    if(d.blocked(x.id,to.id))return d.out(res,403,{error:'Conversation bloquée'});
    const mine=[...rooms.values()].filter(r=>r.hostId===x.id);
    while(mine.length>=4)closeRoom(mine.shift());
    const code=newCode();
    rooms.set(code,{code,mode,hostId:x.id,hostName:x.name,guestId:to.id,guestName:to.name,
      createdAt:Date.now(),clients:new Map(),game:null,timer:null,emptySince:0});
    const m={id:d.uid(),from:x.id,fromName:x.name,to:to.id,toName:to.name,
      text:'🎮 '+x.name+' t’invite à jouer : '+MODES[mode],type:'game',mediaUrl:null,
      mime:'game:'+mode+':'+code,createdAt:Date.now(),deletedFor:[]};
    d.addMessage(m,to,x);
    return d.out(res,200,{ok:true,room:code,mode,message:m});
  }
  if(req.method==='GET'&&u.pathname==='/api/game/invites'){
    const list=[];
    for(const r of rooms.values()){
      if(r.guestId===x.id&&Date.now()-r.createdAt<TTL&&r.clients.has(r.hostId)&&!r.clients.has(x.id))
        list.push({room:r.code,mode:r.mode,from:r.hostName,createdAt:r.createdAt});
    }
    return d.out(res,200,{invites:list});
  }
  return d.out(res,404,{error:'Route introuvable'});
}

setInterval(()=>{
  const now=Date.now();
  for(const r of [...rooms.values()]){
    if(now-r.createdAt>TTL||(!r.clients.size&&r.emptySince&&now-r.emptySince>120000)||(!r.clients.size&&!r.emptySince&&now-r.createdAt>5*60*1000))closeRoom(r);
  }
},30000).unref();

module.exports={attachWs,api};
