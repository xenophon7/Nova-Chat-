/* Energy Arena — serveur multijoueur (WebSocket intégré, sans dépendance) */
'use strict';
const crypto=require('crypto');
const WW=2800,WH=1900,WALL=26,EXP_R=150,WIN_KILLS=10,MAX_PLAYERS=6;
const SP={ast1:[190,191],ast2:[190,187],ast3:[190,200],ast4:[190,196],rockA:[94,185],rockB:[68,184],sat1:[122,202],sat2:[134,106],station:[138,200]};
const OBS=[["ast1",700,450],["ast2",2100,1450],["ast3",1000,1400],["ast4",1900,500],["ast2",1400,330],["ast1",1400,1600],["ast3",2300,1000],["ast4",500,1000],["rockA",1000,800],["rockA",1800,1150],["rockB",600,1500],["rockB",2250,650],["sat1",2400,1500],["sat2",800,250],["sat2",2000,1700],["station",1700,280]]
 .map(([t,cx,cy])=>{const [w,h]=SP[t];return t.startsWith('ast')?{c:1,cx,cy,r:w*.42}:{x:cx-w*.4,y:cy-h*.46,w:w*.8,h:h*.92}});
function pushOut(o,r,k){
  if(k.c){const dx=o.x-k.cx,dy=o.y-k.cy,d=Math.hypot(dx,dy)||1,m=r+k.r;if(d<m){o.x=k.cx+dx/d*m;o.y=k.cy+dy/d*m}return}
  const cx=Math.max(k.x,Math.min(k.x+k.w,o.x)),cy=Math.max(k.y,Math.min(k.y+k.h,o.y)),dx=o.x-cx,dy=o.y-cy,d=Math.hypot(dx,dy);
  if(d>=r)return; if(d===0){o.y=k.y-r}else{o.x=cx+dx/d*r;o.y=cy+dy/d*r}
}
const hitObs=(b,k)=>k.c?Math.hypot(b.x-k.cx,b.y-k.cy)<k.r:(b.x>k.x&&b.x<k.x+k.w&&b.y>k.y&&b.y<k.y+k.h);
function spawnFree(avoid,minD){
  for(let i=0;i<60;i++){
    const x=70+Math.random()*(WW-140),y=70+Math.random()*(WH-140);
    if(avoid.some(p=>Math.hypot(x-p.x,y-p.y)<minD))continue;
    if(OBS.some(k=>k.c?Math.hypot(x-k.cx,y-k.cy)<k.r+40:(x>k.x-40&&x<k.x+k.w+40&&y>k.y-40&&y<k.y+k.h+40)))continue;
    return{x,y};
  }
  return{x:100,y:100};
}
const rooms=new Map(),conns=new Set();
const newCode=()=>{let c;do{c=Array.from({length:5},()=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]).join('')}while(rooms.has(c));return c};

/* ---------- WebSocket minimal ---------- */
function send(c,o){
  if(c.dead)return;const d=Buffer.from(JSON.stringify(o));let h;
  if(d.length<126)h=Buffer.from([0x81,d.length]);
  else if(d.length<65536){h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(d.length,2)}
  else{h=Buffer.alloc(10);h[0]=0x81;h[1]=127;h.writeBigUInt64BE(BigInt(d.length),2)}
  try{c.sock.write(Buffer.concat([h,d]))}catch{}
}
function onData(c,chunk){
  c.buf=Buffer.concat([c.buf,chunk]);
  while(c.buf.length>=2){
    const b=c.buf,op=b[0]&15,masked=b[1]&128;let len=b[1]&127,off=2;
    if(len===126){if(b.length<4)return;len=b.readUInt16BE(2);off=4}
    else if(len===127){if(b.length<10)return;len=Number(b.readBigUInt64BE(2));off=10}
    if(len>1e5)return kill(c);
    const mk=masked?4:0,need=off+mk+len;if(b.length<need)return;
    let p=Buffer.from(b.slice(off+mk,need));
    if(masked){const m=b.slice(off,off+4);for(let i=0;i<p.length;i++)p[i]^=m[i&3]}
    c.buf=b.slice(need);
    if(op===8)return kill(c);
    if(op===9){try{c.sock.write(Buffer.concat([Buffer.from([0x8A,Math.min(p.length,125)]),p.slice(0,125)]))}catch{}}
    else if(op===1){c.seen=Date.now();try{onMsg(c,JSON.parse(p.toString()))}catch(e){}}
  }
}
function kill(c){if(c.dead)return;c.dead=true;leave(c);conns.delete(c);try{c.sock.destroy()}catch{}}

/* ---------- Salons ---------- */
const bcast=(r,o)=>r.players.forEach(p=>send(p.c,o));
function lobbyInfo(r){return{t:'lobby',code:r.code,mode:r.mode,host:r.host,state:r.state,players:[...r.players.values()].map(p=>({id:p.id,name:p.name,ch:p.ch,col:p.col}))}}
function resetPlayer(r,p,hp){const s=spawnFree([...r.players.values()].filter(q=>q!==p&&q.al),r.mode==='pvp'?700:300);p.x=s.x;p.y=s.y;p.hp=hp;p.al=true;p.sh=0;p.f=false;send(p.c,{t:'tp',x:p.x,y:p.y})}
function addPlayer(r,c,ch,col){
  const p={id:c.id,name:c.name,c,ch:String(ch||'blanc').slice(0,12),col:/^#[0-9a-f]{6}$/i.test(col)?col:'#00d4ff',x:WW/2,y:WH/2,a:0,hp:100,sh:0,sCd:0,gCd:0,f:false,lastShot:0,al:true,sc:0,k:0,d:0,rs:0};
  r.players.set(c.id,p);c.room=r;
  if(r.state==='playing'){resetPlayer(r,p,100);send(c,{t:'start',mode:r.mode})}
  bcast(r,lobbyInfo(r));
}
function leave(c){
  const r=c.room;if(!r)return;c.room=null;r.players.delete(c.id);
  if(!r.players.size){rooms.delete(r.code);return}
  if(r.host===c.id)r.host=r.players.keys().next().value;
  bcast(r,lobbyInfo(r));checkEnd(r);
}
function startRoom(r){
  r.state='playing';r.wave=0;r.bots=[];r.bul=[];r.gre=[];r.waveActive=false;r.timer=0;
  r.players.forEach(p=>{p.sc=p.k=p.d=0;resetPlayer(r,p,100);send(p.c,{t:'start',mode:r.mode})});
  bcast(r,lobbyInfo(r));
  if(r.mode==='pve')nextWave(r);
}
function nextWave(r){
  r.wave++;r.waveActive=true;const count=5+(r.wave-1)*2,boss=r.wave%5===0,big=r.wave>=5;
  r.players.forEach(p=>{if(!p.al)resetPlayer(r,p,50)});
  const pl=[...r.players.values()];
  for(let i=0;i<count;i++){
    if(boss&&i===0)r.bots.push({x:WW/2,y:200,r:45,sp:.8,hp:200,mh:200,boss:1,cd:0,a:0,hue:300});
    else{const s=spawnFree(pl,650);r.bots.push({x:s.x,y:s.y,r:big?20:15,sp:1.5+Math.random()-(big?.3:0),hp:big?35:25,mh:big?35:25,boss:0,cd:0,a:0,hue:85+Math.random()*50})}
  }
}
function hurt(r,p,n,by){
  if(!p.al||p.sh>0)return;p.hp-=n;if(p.hp>0)return;
  p.hp=0;p.al=false;p.d++;p.f=false;
  if(r.mode==='pvp'){const k=by&&r.players.get(by);if(k&&k!==p){k.k++;k.sc+=10;if(k.k>=WIN_KILLS)return endRoom(r,k.name+' remporte la partie !')}p.rs=180}
  else checkEnd(r);
}
function checkEnd(r){if(r.mode==='pve'&&r.state==='playing'&&r.players.size&&![...r.players.values()].some(p=>p.al))endRoom(r,'Tous les joueurs sont éliminés — vague '+r.wave)}
function endRoom(r,text){
  if(r.state!=='playing')return;r.state='over';r.timer=240;
  bcast(r,{t:'over',text,board:[...r.players.values()].map(p=>({name:p.name,sc:p.sc,k:p.k,d:p.d})).sort((a,b)=>b.sc-a.sc)});
}
function killBot(r,e,by){const i=r.bots.indexOf(e);if(i<0)return;r.bots.splice(i,1);const p=r.players.get(by);if(p)p.sc+=10}
function step(r){
  const ps=[...r.players.values()],pve=r.mode==='pve',now=Date.now();
  for(const p of ps){
    if(p.sh>0)p.sh--;if(p.sCd>0)p.sCd--;if(p.gCd>0)p.gCd--;
    if(!p.al){if(!pve&&--p.rs<=0)resetPlayer(r,p,100);continue}
    if(p.f&&now-p.lastShot>120){p.lastShot=now;r.bul.push({x:p.x+Math.cos(p.a)*30,y:p.y+Math.sin(p.a)*30,vx:Math.cos(p.a)*12,vy:Math.sin(p.a)*12,o:p.id})}
  }
  r.bul=r.bul.filter(b=>{
    b.x+=b.vx;b.y+=b.vy;
    if(b.x<0||b.x>WW||b.y<0||b.y>WH||OBS.some(k=>hitObs(b,k)))return false;
    if(b.boss){for(const p of ps)if(p.al&&Math.hypot(b.x-p.x,b.y-p.y)<26){hurt(r,p,12);return false}return true}
    if(pve){for(const e of r.bots)if(Math.hypot(b.x-e.x,b.y-e.y)<e.r+4){e.hp-=12;if(e.hp<=0)killBot(r,e,b.o);return false}}
    else for(const p of ps)if(p.al&&p.id!==b.o&&Math.hypot(b.x-p.x,b.y-p.y)<24){hurt(r,p,12,b.o);return false}
    return true;
  });
  r.gre=r.gre.filter(g=>{
    g.t++;g.x+=g.vx;g.y+=g.vy;g.vx*=.955;g.vy*=.955;
    if(OBS.some(k=>hitObs(g,k))){g.x-=g.vx;g.y-=g.vy;g.vx=g.vy=0}
    g.x=Math.max(WALL,Math.min(WW-WALL,g.x));g.y=Math.max(WALL,Math.min(WH-WALL,g.y));
    if(g.t<75)return true;
    r.ev.push([Math.round(g.x),Math.round(g.y)]);
    if(pve)r.bots.slice().forEach(e=>{const d=Math.hypot(e.x-g.x,e.y-g.y),m=EXP_R+e.r;if(d<m){e.hp-=70*(1-d/m*.5);if(e.hp<=0)killBot(r,e,g.o)}});
    else ps.forEach(p=>{if(p.id===g.o)return;const d=Math.hypot(p.x-g.x,p.y-g.y),m=EXP_R+20;if(p.al&&d<m)hurt(r,p,50*(1-d/m*.5),g.o)});
    return false;
  });
  if(!pve||!r.waveActive){if(pve&&r.state==='playing'&&--r.timer<=0)nextWave(r);return}
  for(const e of r.bots){
    let t=null,bd=1e9;for(const p of ps)if(p.al){const d=Math.hypot(p.x-e.x,p.y-e.y);if(d<bd){bd=d;t=p}}
    if(!t)break;
    const dx=t.x-e.x,dy=t.y-e.y,dist=bd||1;
    e.x+=dx/dist*e.sp;e.y+=dy/dist*e.sp;OBS.forEach(k=>pushOut(e,e.r,k));e.a=Math.atan2(dy,dx);
    if(e.boss&&--e.cd<=0){r.bul.push({x:e.x,y:e.y,vx:Math.cos(e.a)*6,vy:Math.sin(e.a)*6,boss:1});e.cd=40}
    if(dist<e.r+20){hurt(r,t,8);e.x-=dx/dist*15;e.y-=dy/dist*15}
  }
  if(!r.bots.length&&r.state==='playing'){r.waveActive=false;r.timer=180;bcast(r,{t:'msg',text:'Vague '+r.wave+' terminée !'})}
}
function snap(r){
  const o={t:'s',w:r.wave,m:r.mode,left:r.bots.length,
    pl:[...r.players.values()].map(p=>({i:p.id,x:Math.round(p.x),y:Math.round(p.y),a:+p.a.toFixed(2),h:Math.round(p.hp),s:p.sh,al:p.al?1:0,f:p.f?1:0,k:p.k,sc:p.sc,gc:p.gCd,sd:p.sCd})),
    b:r.bul.map(b=>[Math.round(b.x),Math.round(b.y),b.vx,b.vy,b.boss?1:0]),
    e:r.bots.map(e=>[Math.round(e.x),Math.round(e.y),Math.round(e.hp),e.mh,e.r,e.boss,Math.round(e.hue),+e.a.toFixed(2)]),
    g:r.gre.map(g=>[Math.round(g.x),Math.round(g.y),g.t]),x:r.ev};
  r.ev=[];return JSON.stringify(o);
}
function tickAll(){
  for(const r of rooms.values()){
    if(r.state==='playing'){step(r);step(r);const s=snap(r);r.players.forEach(p=>{if(!p.c.dead)try{p.c.sock.write(frame(s))}catch{}})}
    else if(r.state==='over'&&--r.timer<=0){r.state='lobby';r.bots=[];r.bul=[];r.gre=[];bcast(r,lobbyInfo(r))}
  }
}
function frame(s){const d=Buffer.from(s);let h;if(d.length<126)h=Buffer.from([0x81,d.length]);else if(d.length<65536){h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(d.length,2)}else{h=Buffer.alloc(10);h[0]=0x81;h[1]=127;h.writeBigUInt64BE(BigInt(d.length),2)}return Buffer.concat([h,d])}

function onMsg(c,m){
  const r=c.room,p=r&&r.players.get(c.id);
  switch(m.t){
    case 'presence':c.status=m.s==='solo'?'solo':'menu';break;
    case 'create':
      if(r)leave(c);{const nr={code:newCode(),mode:m.mode==='pvp'?'pvp':'pve',host:c.id,players:new Map(),state:'lobby',wave:0,bots:[],bul:[],gre:[],ev:[],timer:0,waveActive:false};rooms.set(nr.code,nr);addPlayer(nr,c,m.ch,m.col)}break;
    case 'join':{
      const j=rooms.get(String(m.code||'').toUpperCase().trim());
      if(!j)return send(c,{t:'err',text:'Salon introuvable (code incorrect ou partie terminée).'});
      if(j.players.size>=MAX_PLAYERS&&!j.players.has(c.id))return send(c,{t:'err',text:'Salon complet.'});
      if(r&&r!==j)leave(c);
      if(!j.players.has(c.id))addPlayer(j,c,m.ch,m.col);else send(c,lobbyInfo(j));
      break}
    case 'start':if(r&&r.host===c.id&&r.state==='lobby')startRoom(r);break;
    case 'leave':leave(c);break;
    case 'in':if(p&&p.al&&r.state==='playing'){
      const q={x:Number(m.x),y:Number(m.y)};
      if(Number.isFinite(q.x)&&Number.isFinite(q.y)){q.x=Math.max(WALL+20,Math.min(WW-WALL-20,q.x));q.y=Math.max(WALL+20,Math.min(WH-WALL-20,q.y));OBS.forEach(k=>pushOut(q,20,k));p.x=q.x;p.y=q.y}
      p.a=Number(m.a)||0;p.f=!!m.f}break;
    case 'g':if(p&&p.al&&r.state==='playing'&&p.gCd<=0&&(r.mode==='pvp'||r.waveActive)){p.gCd=180;const h={x:p.x+Math.cos(p.a)*30,y:p.y+Math.sin(p.a)*30};r.gre.push({x:h.x,y:h.y,vx:Math.cos(p.a)*11,vy:Math.sin(p.a)*11,t:0,o:p.id})}break;
    case 's':if(p&&p.al&&r.state==='playing'&&p.sCd<=0){p.sh=240;p.sCd=720}break;
  }
}
function attach(server,{auth}){
  server.on('upgrade',(req,sock)=>{
    try{
      const u=new URL(req.url,'http://x'),key=req.headers['sec-websocket-key'];
      if(u.pathname!=='/game-ws'||!key)return sock.destroy();
      const user=auth(req);
      if(!user){sock.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return sock.destroy()}
      const acc=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+acc+'\r\n\r\n');
      sock.setNoDelay(true);
      const c={sock,id:user.id,name:user.name,buf:Buffer.alloc(0),room:null,status:'menu',since:Date.now(),seen:Date.now()};
      for(const o of [...conns])if(o.id===user.id)kill(o); // une seule connexion par compte
      conns.add(c);
      sock.on('data',d=>onData(c,d));sock.on('close',()=>kill(c));sock.on('error',()=>kill(c));
      send(c,{t:'hi',id:user.id,name:user.name});
    }catch{try{sock.destroy()}catch{}}
  });
  setInterval(tickAll,33);
  setInterval(()=>{const n=Date.now();conns.forEach(c=>{if(n-c.seen>60000)kill(c)})},10000);
}
function presence(){
  return [...conns].map(c=>{
    const st=c.room?(c.room.state==='lobby'?'lobby':'multi'):c.status;
    return{id:c.id,name:c.name,status:st,playing:st==='solo'||st==='multi',room:c.room?c.room.code:null,mode:c.room?c.room.mode:null,since:c.since};
  });
}
const hasRoom=code=>rooms.has(String(code||'').toUpperCase());
module.exports={attach,presence,hasRoom};
