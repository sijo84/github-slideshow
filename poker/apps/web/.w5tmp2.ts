import { PerspectiveCamera, Vector3 } from 'three';
import { cameraFor, hudSizeFor, potPosition, boardPosition, dealerPositionFor, muckPosition } from './src/table/layout.js';
type V=[number,number,number];
function mk(w:number,h:number,win:number){const c=cameraFor(w/h,{width:w,height:h,...hudSizeFor(win)});const cam=new PerspectiveCamera(40,w/h);cam.position.set(...c.position);cam.lookAt(...c.lookAt);cam.updateMatrixWorld();
 return (p:V)=>{const v=new Vector3(...p).project(cam);return [(v.x+1)/2*w,(1-v.y)/2*h].map(Math.round);};}
for (const [w,h,win] of [[912,513,1280],[374,281,390]]){const pr=mk(w,h,win);console.log(w,h);
for (let deg=0;deg<360;deg+=20){const a=deg*Math.PI/180;console.log(deg,'seat',pr([-4.2*Math.sin(a),0,2.4*Math.cos(a)]),'f.6',pr([-4.2*Math.sin(a)*.6,0,2.4*Math.cos(a)*.6]));}
console.log('pots',[0,1,2,3,4].map(i=>pr(potPosition(i))).join(' | '),'board',[0,4].map(i=>pr(boardPosition(i))).join(' | '),'dealer',pr(dealerPositionFor(9)),pr(dealerPositionFor(8)),'muck',pr(muckPosition));
console.log('unit x at center px', pr([1,0,0])[0]-pr([0,0,0])[0], 'unit z at center px', pr([0,0,1])[1]-pr([0,0,0])[1], 'unit z at top', pr([0,0,-1.5])[1]-pr([0,0,-2.5])[1]);}
