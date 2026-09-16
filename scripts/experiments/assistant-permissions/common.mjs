// Disposable native-harness experiments; not loaded by Hosty product code.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
export const args = Object.fromEntries(process.argv.slice(2).reduce((a,v,i,all)=>i%2?a:[...a,[v.replace(/^--/,''),all[i+1]]],[]));
export function requireArgs() { if (!args.deps || !args.out) throw new Error('Required: --deps <isolated npm prefix> --out <new evidence directory>'); }
export function fixture(out) {
  fs.mkdirSync(out,{recursive:true});
  const root=path.resolve(args.fixtures??path.join(out,'fixtures'));
  if(fs.existsSync(root))throw new Error('Fixture directory must be new: '+root);
  for(const p of ['a/source','b/source','c/source','cache','secrets','tmp'])fs.mkdirSync(path.join(root,p),{recursive:true});
  fs.writeFileSync(path.join(root,'secrets/token.txt'),'SYNTHETIC_SECRET_DO_NOT_DISCLOSE');
  fs.writeFileSync(path.join(root,'a/source/public.txt'),'public fixture\n');
  for(const [name,target] of [['secret-link','secrets'],['outside-link','c/source']]) {
    try{fs.symlinkSync(path.join(root,target),path.join(root,'a/source',name));}catch(e){if(e.code!=='EEXIST')throw e;}
  }
  return {root,a:root+'/a/source',b:root+'/b/source',c:root+'/c/source',cache:root+'/cache',secret:root+'/secrets',tmp:root+'/tmp'};
}
export function cleanEnv(extra={}) {
 return {PATH:process.env.PATH,HOME:process.env.HOME,LANG:'en_US.UTF-8',...extra};
}
export const delay=ms=>new Promise(r=>setTimeout(r,ms));
export function save(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');}
export function rpcChild(command,argv,options){
 const child=spawn(command,argv,{...options,stdio:['pipe','pipe','pipe']});
 let buffer='',seq=0;const pending=new Map(),events=[],stderr=[];
 const send=m=>child.stdin.write(JSON.stringify(m)+'\n');
 const listeners=new Set();
 child.stderr.on('data',d=>stderr.push(String(d)));
 child.stdout.on('data',d=>{buffer+=d;for(;;){const i=buffer.indexOf('\n');if(i<0)break;const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let m;try{m=JSON.parse(line)}catch{continue}
  if(m.id!==undefined&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}
  else{events.push(m);for(const fn of listeners)fn(m);if(m.id!==undefined&&m.method){if(m.method.endsWith('/requestApproval'))send({id:m.id,result:{decision:'decline'}});else send({id:m.id,error:{code:-32601,message:'Not enabled in experiment'}});}}
 }});
 child.on('exit',code=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('RPC child exited '+code+': '+stderr.join('').slice(-1000)));}pending.clear();});
 return {child,events,stderr,listeners,send,rpc:(method,params,timeout=30000)=>new Promise((resolve,reject)=>{
  const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timeout: '+method));},timeout);pending.set(id,{resolve,reject,timer});send({id,method,params});
 }),stop(){child.kill('SIGTERM');}};
}
