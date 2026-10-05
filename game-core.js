/* Energy Arena — moteur de jeu partagé (navigateur pour le solo, serveur pour le multijoueur) */
(function(g){
'use strict';
const W=2400,H=1600,PR=20,SPEED=300,BSPEED=720,BLIFE=1.1,HP=100,KILLS=10;
const OBST=[
 [560,300,220,60],[1620,300,220,60],[560,1240,220,60],[1620,1240,220,60],
 [330,640,60,320],[2010,640,60,320],
 [960,460,60,240],[1380,900,60,240],[1100,330,200,60],[1100,1210,200,60],
 [740,760,130,130],[1530,710,130,130],[900,1040,150,60],[1350,500,150,60]
];
const PVP_SPAWNS=[[180,800],[2220,800]];
const rnd=(a,b)=>a+Math.random()*(b-a),rd=Math.round;
const num=(v,lo,hi)=>{v=Number(v);return isFinite(v)?Math.max(lo,Math.min(hi,v)):0};

function inObst(x,y,r){
  for(const [rx,ry,rw,rh] of OBST){
    const cx=Math.max(rx,Math.min(x,rx+rw)),cy=Math.max(ry,Math.min(y,ry+rh));
    if((x-cx)*(x-cx)+(y-cy)*(y-cy)<r*r)return true;
  }
  return false;
}
function pushOut(o,r){
  let hit=false;
  for(const [rx,ry,rw,rh] of OBST){
    const cx=Math.max(rx,Math.min(o.x,rx+rw)),cy=Math.max(ry,Math.min(o.y,ry+rh));
    const dx=o.x-cx,dy=o.y-cy,d2=dx*dx+dy*dy;
    if(d2>=r*r)continue;
    hit=true;
    if(d2>1e-6){const d=Math.sqrt(d2),k=(r-d)/d;o.x+=dx*k;o.y+=dy*k}
    else{
      const l=o.x-rx,rr=rx+rw-o.x,t=o.y-ry,b=ry+rh-o.y,m=Math.min(l,rr,t,b);
      if(m===l)o.x=rx-r;else if(m===rr)o.x=rx+rw+r;else if(m===t)o.y=ry-r;else o.y=ry+rh+r;
    }
  }
  return hit;
}

class Game{
  constructor(o){
    o=o||{};
    this.mode=(o.mode==='pvp'||o.mode==='coop')?o.mode:'solo';
    this.players=new Map();this.enemies=[];this.bullets=[];this.nid=1;this.wave=1;
    this.phase=this.mode==='pvp'?'waiting':'idle';this.pt=0;this.ev=[];this.winner=null;this.forfeit=false;
  }
  _spawnPoint(idx){
    if(this.mode==='pvp')return PVP_SPAWNS[idx%2];
    return [[1200,800],[1270,800],[1130,800],[1200,870]][idx%4];
  }
  _place(p,idx){const s=this._spawnPoint(idx);p.x=s[0];p.y=s[1];p.hp=HP;p.al=true;p.rt=0;p.cd=0}
  addPlayer(id,info){
    info=info||{};
    const p={id,name:String(info.name||'Joueur').slice(0,20),color:info.color||'#00d4ff',eyes:info.eyes||'normal',
      x:0,y:0,a:0,hp:HP,al:true,sc:0,k:0,d:0,rt:0,cd:0,inp:{mx:0,my:0,ax:0,ay:0,f:0}};
    this.players.set(id,p);this._place(p,this.players.size-1);
    if(this.mode!=='pvp'&&this.phase==='idle')this.startWave();
    return p;
  }
  removePlayer(id){
    this.players.delete(id);
    if(this.mode==='pvp'){
      if(this.players.size<2&&(this.phase==='countdown'||this.phase==='play')){
        const left=[...this.players.values()][0];
        this.phase='ended';this.winner=left?left.id:null;this.forfeit=true;this.bullets.length=0;
      }else if(this.players.size<2&&this.phase!=='ended'){this.phase='waiting'}
    }else if(this.players.size&&![...this.players.values()].some(q=>q.al)&&this.phase!=='over')this.phase='over';
  }
  setInput(id,i){
    const p=this.players.get(id);if(!p||!i)return;
    p.inp={mx:num(i.mx,-1,1),my:num(i.my,-1,1),ax:num(i.ax,-1,1),ay:num(i.ay,-1,1),f:i.f?1:0};
  }
  _freePoint(r){
    const alive=[...this.players.values()].filter(p=>p.al);
    for(let n=0;n<40;n++){
      const x=rnd(60,W-60),y=rnd(60,H-60);
      if(inObst(x,y,r+12))continue;
      if(alive.every(p=>Math.hypot(p.x-x,p.y-y)>650))return [x,y];
    }
    return [rnd(60,W-60),60];
  }
  startWave(){
    this.phase='wave';this.pt=0;
    const w=this.wave,boss=w%5===0,big=w>=5;
    const count=5+(w-1)*2+(this.players.size-1)*3;
    let idx=0;
    for(const p of this.players.values()){if(!p.al){this._place(p,idx);p.hp=60}idx++}
    for(let i=0;i<count;i++){
      if(boss&&i===0){
        this.enemies.push({id:this.nid++,x:W/2,y:150,r:45,sp:48,hp:200,mhp:200,boss:1,h:330,cd:1,ccd:0,slide:0,sd:1});
      }else{
        const r=big?20:15,pt=this._freePoint(r);
        this.enemies.push({id:this.nid++,x:pt[0],y:pt[1],r,sp:(1.5+Math.random()-(big?0.3:0))*60,
          hp:big?35:25,mhp:big?35:25,boss:0,h:rd(rnd(0,360)),cd:0,ccd:0,slide:0,sd:1});
      }
    }
  }
  nextWave(){if(this.phase==='between'){this.wave++;this.startWave()}}
  restart(){
    this.enemies.length=0;this.bullets.length=0;this.wave=1;this.winner=null;this.forfeit=false;this.pt=0;
    let idx=0;
    for(const p of this.players.values()){p.sc=p.k=p.d=0;this._place(p,idx++)}
    if(this.mode==='pvp')this.phase=this.players.size>=2?'countdown':'waiting',this.pt=3;
    else{this.phase='idle';if(this.players.size)this.startWave()}
  }
  _hurt(p,dmg,by){
    if(!p.al)return;
    p.hp-=dmg;this.ev.push(['h',p.id]);
    if(p.hp>0)return;
    p.hp=0;p.al=false;p.d++;this.ev.push(['d',p.id]);
    if(this.mode==='pvp'){
      const k=by&&this.players.get(by);
      if(k&&k!==p){k.k++;k.sc=k.k;if(k.k>=KILLS){this.phase='ended';this.winner=k.id;this.bullets.length=0}}
      p.rt=2;
    }else if(![...this.players.values()].some(q=>q.al))this.phase='over';
  }
  step(dt){
    dt=Math.min(Math.max(dt,0),0.1);
    const n=Math.max(1,Math.ceil(dt/(1/60))),h=dt/n;
    for(let i=0;i<n;i++)this._tick(h);
  }
  _tick(h){
    const ph=this.phase,pvp=this.mode==='pvp';
    if(pvp){
      if(ph==='waiting'&&this.players.size>=2){
        this.phase='countdown';this.pt=3;let i=0;
        for(const p of this.players.values()){p.sc=p.k=p.d=0;this._place(p,i++)}
        this.bullets.length=0;
      }else if(ph==='countdown'){this.pt-=h;if(this.pt<=0){this.phase='play';this.pt=0}}
    }
    if(ph==='between'&&this.mode==='coop'){this.pt-=h;if(this.pt<=0)this.nextWave()}
    const cur=this.phase;
    const canMove=cur==='wave'||cur==='between'||cur==='play'||cur==='waiting';
    const canShoot=cur==='wave'||cur==='play'||cur==='waiting';
    const fireDelay=pvp?0.15:0.12;
    for(const p of this.players.values()){
      if(!p.al){
        if(pvp&&cur==='play'){p.rt-=h;if(p.rt<=0){const o=[...this.players.values()].find(q=>q!==p&&q.al);
          let best=PVP_SPAWNS[0];if(o&&Math.hypot(o.x-PVP_SPAWNS[1][0],o.y-PVP_SPAWNS[1][1])<Math.hypot(o.x-PVP_SPAWNS[0][0],o.y-PVP_SPAWNS[0][1]))best=PVP_SPAWNS[0];else if(o)best=PVP_SPAWNS[1];
          p.x=best[0];p.y=best[1];p.hp=HP;p.al=true;p.cd=0}}
        continue;
      }
      p.cd-=h;
      if(!canMove)continue;
      let mx=p.inp.mx,my=p.inp.my;const m=Math.hypot(mx,my);if(m>1){mx/=m;my/=m}
      p.x=Math.max(PR,Math.min(W-PR,p.x+mx*SPEED*h));p.y=Math.max(PR,Math.min(H-PR,p.y+my*SPEED*h));
      pushOut(p,PR);
      const am=Math.hypot(p.inp.ax,p.inp.ay);
      if(am>0.2)p.a=Math.atan2(p.inp.ay,p.inp.ax);
      if(p.inp.f&&am>0.2&&canShoot&&p.cd<=0){
        p.cd=fireDelay;
        this.bullets.push({id:this.nid++,x:p.x,y:p.y,vx:Math.cos(p.a)*BSPEED,vy:Math.sin(p.a)*BSPEED,o:p.id,boss:0,r:4,life:BLIFE,dmg:pvp?8:12});
        this.ev.push(['s',p.id]);
      }
    }
    if(cur==='wave')this._enemies(h);
    this._bullets(h);
    if(this.phase==='wave'&&this.enemies.length===0){this.phase='between';this.pt=this.mode==='coop'?6:0}
  }
  _enemies(h){
    const alive=[...this.players.values()].filter(p=>p.al);
    if(!alive.length)return;
    for(const e of this.enemies){
      let t=alive[0],bd=Infinity;
      for(const p of alive){const d=Math.hypot(p.x-e.x,p.y-e.y);if(d<bd){bd=d;t=p}}
      const dist=Math.max(bd,0.001);
      let dx=(t.x-e.x)/dist,dy=(t.y-e.y)/dist;
      if(e.slide>0){e.slide-=h;const tx=-dy*e.sd,ty=dx*e.sd;dx=tx*0.9+dx*0.3;dy=ty*0.9+dy*0.3;const l=Math.hypot(dx,dy)||1;dx/=l;dy/=l}
      e.x+=dx*e.sp*h;e.y+=dy*e.sp*h;
      if(pushOut(e,e.r)){e.slide=0.6;e.sd=e.id%2?1:-1}
      if(e.boss){
        e.cd-=h;
        if(e.cd<=0){
          const a=Math.atan2(t.y-e.y,t.x-e.x);
          this.bullets.push({id:this.nid++,x:e.x,y:e.y,vx:Math.cos(a)*360,vy:Math.sin(a)*360,o:0,boss:1,r:6,life:3,dmg:12});
          e.cd=0.67;
        }
      }
      e.ccd-=h;
      for(const p of alive){
        if(!p.al)continue;
        if(Math.hypot(p.x-e.x,p.y-e.y)<e.r+PR&&e.ccd<=0){
          e.ccd=0.4;this._hurt(p,8,0);
          const a=Math.atan2(p.y-e.y,p.x-e.x);e.x-=Math.cos(a)*15;e.y-=Math.sin(a)*15;
        }
      }
    }
  }
  _bullets(h){
    const pvp=this.mode==='pvp';
    for(let i=this.bullets.length-1;i>=0;i--){
      const b=this.bullets[i];
      b.x+=b.vx*h;b.y+=b.vy*h;b.life-=h;
      if(b.life<=0||b.x<0||b.x>W||b.y<0||b.y>H||inObst(b.x,b.y,b.r)){this.bullets.splice(i,1);continue}
      let used=false;
      if(b.boss||pvp){
        for(const p of this.players.values()){
          if(!p.al||p.id===b.o)continue;
          if(Math.hypot(b.x-p.x,b.y-p.y)<PR+b.r){this._hurt(p,b.dmg,b.o);used=true;break}
        }
      }else{
        for(let j=this.enemies.length-1;j>=0;j--){
          const e=this.enemies[j];
          if(Math.hypot(b.x-e.x,b.y-e.y)<e.r+b.r){
            e.hp-=b.dmg;used=true;
            if(e.hp<=0){
              this.enemies.splice(j,1);this.ev.push(['k',0]);
              const o=this.players.get(b.o);if(o){o.sc+=10;o.k++}
            }
            break;
          }
        }
      }
      if(used)this.bullets.splice(i,1);
    }
  }
  snapshot(){
    const ev=this.ev;this.ev=[];
    return{
      ph:this.phase,pt:Math.max(0,rd(this.pt*10)/10),w:this.wave,l:this.enemies.length,win:this.winner,ff:this.forfeit?1:0,
      p:[...this.players.values()].map(p=>[p.id,rd(p.x),rd(p.y),rd(p.a*100)/100,p.hp,p.al?1:0,p.sc,p.k,p.d]),
      e:this.enemies.map(e=>[e.id,rd(e.x),rd(e.y),e.r,e.hp,e.mhp,e.boss,e.h]),
      b:this.bullets.map(b=>[b.id,rd(b.x),rd(b.y),rd(b.vx),rd(b.vy),b.boss]),
      ev
    };
  }
}

const API={W,H,PR,OBST,KILLS,create:o=>new Game(o)};
if(typeof module!=='undefined'&&module.exports)module.exports=API;else g.NovaGame=API;
})(typeof window!=='undefined'?window:globalThis);
