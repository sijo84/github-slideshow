import { PerspectiveCamera, Vector3 } from 'three';
import { cameraFor, hudSizeFor } from './src/table/layout.js';
type V=[number,number,number];
function mk(w:number,h:number,win:number){const c=cameraFor(w/h,{width:w,height:h,...hudSizeFor(win)});const cam=new PerspectiveCamera(40,w/h);cam.position.set(...c.position);cam.lookAt(...c.lookAt);cam.updateMatrixWorld();
 return (p:V)=>{const v=new Vector3(...p).project(cam);return [(v.x+1)/2*w,(1-v.y)/2*h];};}
const cfgs=[{w:912,h:513,win:1280,hw:127,hh:146,lw:60,lh:22},{w:374,h:281,win:390,hw:72,hh:44,lw:60,lh:22}];
function clear(pr:(p:V)=>number[],seat:V,bet:V,c:any){const [sx,sy]=pr(seat);const [bx,by]=pr(bet);const [ex]=pr([bet[0]+0.22,bet[1],bet[2]]);const r=ex-bx;
 const hud={l:sx-c.hw/2,r:sx+c.hw/2,t:sy-c.hh/2,b:sy+c.hh/2};
 const boxes=[{l:bx-r,r:bx+r,t:by-r*1.4,b:by+r*0.6},{l:bx+r+2,r:bx+r+2+c.lw,t:by-c.lh/2,b:by+c.lh/2}];
 return boxes.every(b=>b.r<=hud.l||b.l>=hud.r||b.b<=hud.t||b.t>=hud.b);}
for (let deg=0;deg<360;deg+=20){const a=deg*Math.PI/180;const seat:V=[-4.2*Math.sin(a),0,2.4*Math.cos(a)];
 const res=cfgs.map(c=>{const pr=mk(c.w,c.h,c.win);let best=-1;for(let f=0.95;f>=0.1;f-=0.01){if(clear(pr,seat,[seat[0]*f,0.02,seat[2]*f],c)){best=f;break;}}return best.toFixed(2);});
 console.log(deg,res.join(' '));}
