import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {args,requireArgs,fixture,cleanEnv,delay,save} from './common.mjs';
requireArgs();
const out=path.resolve(args.out), f=fixture(out);
const {query}=await import(pathToFileURL(path.join(path.resolve(args.deps),'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')));
let script=[],position=0,requests=0;
const server=http.createServer(async(req,res)=>{
 if(!req.url.includes('/messages')){res.writeHead(200);res.end('{}');return;}
 let body='';for await(const d of req)body+=d;const request=JSON.parse(body);requests++;
 const step=script[position++];
 const content=step?[{type:'tool_use',id:'fixture_'+position,name:step.name,input:step.input}]:[{type:'text',text:'Fixture sequence complete.'}];
 const msg={id:'msg_fixture_'+requests,type:'message',role:'assistant',model:request.model,content,stop_reason:step?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:10}};
 if(!request.stream){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(msg));return;}
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const event=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
 event('message_start',{message:{...msg,content:[],stop_reason:null}});
 for(const [index,block]of content.entries()){
  event('content_block_start',{index,content_block:block.type==='tool_use'?{...block,input:{}}:{type:'text',text:''}});
  event('content_block_delta',{index,delta:block.type==='tool_use'?{type:'input_json_delta',partial_json:JSON.stringify(block.input)}:{type:'text_delta',text:block.text}});
  event('content_block_stop',{index});
 }
 event('message_delta',{delta:{stop_reason:msg.stop_reason,stop_sequence:null},usage:{output_tokens:10}});event('message_stop',{});res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const version=JSON.parse(fs.readFileSync(path.join(args.deps,'node_modules/@anthropic-ai/claude-agent-sdk/package.json'))).version;
const results=[];
let probeNumber=0;
const shell=(code)=>{const file=f.a+'/.probe-'+(++probeNumber)+'.cjs';fs.writeFileSync(file,code);return {name:'Bash',input:{command:JSON.stringify(process.execPath)+' '+JSON.stringify(file),timeout:10000}};};
const write=(p,text='fixture')=>({name:'Write',input:{file_path:p,content:text}});
const read=p=>({name:'Read',input:{file_path:p}});
const inside=(p,root)=>p===root||p.startsWith(root+'/');
function canonical(p){try{return fs.realpathSync(p)}catch{return path.join(fs.realpathSync(path.dirname(p)),path.basename(p));}}
async function run(name,{edit=true,commands=true,second=true,resume,steps,interrupt=false,settingsProbe=false,guard=true}={}){
 script=steps;position=0;const messages=[],hooks=[],callbacks=[];let sessionId,revoked=false,q,stopLength;
 const roots=second?[f.a,f.b]:[f.a];
 const options={cwd:f.a,resume,permissionMode:edit?'acceptEdits':'default',additionalDirectories:second?[f.b]:[],settingSources:[],maxTurns:30,
 env:cleanEnv({ANTHROPIC_API_KEY:'synthetic-not-a-real-key',ANTHROPIC_BASE_URL:base,CLAUDE_CONFIG_DIR:out+'/claude-config',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',HOSTY_SYNTHETIC_CONTROL_TOKEN:'fixture-token'}),
 sandbox:{enabled:true,failIfUnavailable:true,autoAllowBashIfSandboxed:commands,allowUnsandboxedCommands:false,
 filesystem:{allowWrite:[...(edit&&second?[f.b]:[]),f.cache],denyWrite:edit?[]:[f.a,f.b],denyRead:[f.secret]},network:{allowedDomains:[]},credentials:{envVars:[{name:'HOSTY_SYNTHETIC_CONTROL_TOKEN',mode:'deny'}]}},
 canUseTool:async(tool,input,context)=>{callbacks.push({tool,input,reason:context.decisionReason,suggestions:context.suggestions,blockedPath:context.blockedPath});return {behavior:'deny',message:'Outside fixture grant'};},
 hooks:{PreToolUse:[{hooks:[async input=>{
  let reason;const tool=input.tool_name, value=input.tool_input;
  if(revoked)reason='Grant revoked';
  else if(tool==='Bash'&&!commands)reason='Command permission disabled';
  else if(['Write','Edit','MultiEdit'].includes(tool)&&!edit)reason='Edit permission disabled';
  else if(['Read','Glob','Grep','Write','Edit','MultiEdit'].includes(tool)){
   const p=value.file_path??value.path??f.a;
   try{const resolved=canonical(path.resolve(f.a,p));if(!roots.some(root=>inside(resolved,root)))reason='Path outside granted source';}catch{reason='Unresolvable path';}
   if(tool==='Glob'&&(path.isAbsolute(value.pattern??'')||(value.pattern??'').split('/').includes('..')))reason='Unscoped glob';
  }else if(tool!=='Bash')reason='Tool outside experimental grant';
  hooks.push({tool,input:value,denied:Boolean(reason)});
  return guard&&reason?{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}}:{};
 }]}]}};
 let watch;
 if(interrupt){watch=setInterval(()=>{const p=f.a+'/heartbeat';if(fs.existsSync(p)&&fs.statSync(p).size>1&&!revoked){revoked=true;stopLength=fs.statSync(p).size;q.interrupt().catch(()=>{});}},20);}
 const timer=setTimeout(()=>q?.close(),45000);
 try{
 q=query({prompt:'Execute the scripted synthetic permission fixture actions. All paths and tokens are disposable.',options});
 for await(const m of q){if(m.type==='system'&&m.subtype==='init')sessionId=m.session_id;
  if(m.type==='user'||m.type==='assistant'||m.type==='result')messages.push(m);
 }
 }catch(e){messages.push({error:String(e)})}finally{clearTimeout(timer);clearInterval(watch);q?.close();}
 if(interrupt)await delay(1200);
 const r={name,sessionId,hooks,callbacks,messages,scriptedSteps:steps.length,servedSteps:position,revoked,stopLength,
 observed:{a:fs.existsSync(f.a+'/'+name),b:fs.existsSync(f.b+'/'+name),cache:fs.existsSync(f.cache+'/'+name),heartbeat:fs.existsSync(f.a+'/heartbeat')?fs.statSync(f.a+'/heartbeat').size:0}};
 results.push(r);save(out+'/claude-results.json',{version,results});console.log(JSON.stringify({name,callbacks:callbacks.length,hookDenials:hooks.filter(x=>x.denied).length,observed:r.observed,revoked}));return r;
}
try{
 const probeCode=name=>`const fs=require('fs');const o={};for(const[k,p]of Object.entries(${JSON.stringify({a:f.a,b:f.b,c:f.c,cache:f.cache})})){try{fs.writeFileSync(p+'/'+${JSON.stringify(name)},'x');o[k]='allowed'}catch(e){o[k]=e.code}}try{o.secret=fs.readFileSync(${JSON.stringify(f.secret+'/token.txt')},'utf8')}catch(e){o.secret=e.code}o.token=process.env.HOSTY_SYNTHETIC_CONTROL_TOKEN??'absent';console.log(JSON.stringify(o));`;
 const both=await run('both',{steps:[write(f.a+'/both'),write(f.b+'/both'),read(f.a+'/public.txt'),read(f.secret+'/token.txt'),read(f.a+'/secret-link/token.txt'),{name:'Grep',input:{pattern:'SYNTHETIC',path:f.secret,output_mode:'content'}},{name:'Glob',input:{pattern:'*',path:f.secret}},shell(probeCode('both'))]});
 await run('edit-only',{commands:false,steps:[write(f.a+'/edit-only'),shell(probeCode('edit-only'))]});
 await run('command-only',{edit:false,steps:[write(f.a+'/command-only'),shell(probeCode('command-only'))]});
 await run('neither',{edit:false,commands:false,steps:[write(f.a+'/neither'),shell(probeCode('neither'))]});
 fs.mkdirSync(f.a+'/.claude',{recursive:true});
 fs.writeFileSync(f.a+'/.claude/settings.json',JSON.stringify({permissions:{allow:['Read('+f.secret+'/**)','Edit('+f.c+'/**)','Bash(*)']},sandbox:{filesystem:{allowWrite:[f.c],allowRead:[f.secret]}}}));
 await run('settings-excluded',{steps:[read(f.secret+'/token.txt'),write(f.c+'/settings-excluded'),shell(probeCode('settings-excluded'))]});
 await run('resume-revoked-b',{second:false,resume:both.sessionId,steps:[write(f.b+'/resume-revoked-b'),shell(probeCode('resume-revoked-b'))]});
 const heartbeat=`const fs=require('fs');const p=${JSON.stringify(f.a+'/heartbeat')};let n=0;const t=setInterval(()=>{fs.appendFileSync(p,'x');if(++n===40)clearInterval(t)},100);`;
 await run('interrupt',{interrupt:true,steps:[shell(heartbeat),write(f.a+'/after-revoke')]});
}finally{server.closeAllConnections();server.close();}
const checks=[];
const check=(name,ok)=>checks.push({name,ok:Boolean(ok)});
const result=name=>results.find(r=>r.name===name);
const outputs=r=>r.messages.flatMap(m=>m.message?.content??[]).filter(b=>b.type==='tool_result').map(b=>b.content);
const shellOutput=r=>outputs(r).findLast(s=>typeof s==='string'&&s.startsWith('{'));
for(const name of ['both','command-only','settings-excluded','resume-revoked-b']){
 const r=result(name);let p;try{p=JSON.parse(shellOutput(r))}catch{}
 check(name+' commands executed',Boolean(p));check(name+' shell secret denied',p?.secret==='EPERM'&&p?.token==='absent');
 check(name+' shell scope',p?.a===(name==='command-only'?'EPERM':'allowed')&&p?.b===(['command-only','resume-revoked-b'].includes(name)?'EPERM':'allowed')&&p?.c==='EPERM'&&p?.cache==='allowed');
}
check('zero approval cards',results.every(r=>r.callbacks.length===0));
check('file secret not disclosed',!JSON.stringify(outputs(result('both'))).includes('SYNTHETIC_SECRET_DO_NOT_DISCLOSE'));
check('file public read works',JSON.stringify(outputs(result('both'))).includes('public fixture'));
check('edit-only',result('edit-only').observed.a&&!result('edit-only').observed.cache);
check('command-only file write denied',!result('command-only').observed.a);
check('neither permission',!result('neither').observed.a&&!result('neither').observed.cache);
check('resume file write denied',!result('resume-revoked-b').observed.b);
check('revocation quiescent',result('interrupt').revoked&&result('interrupt').stopLength>=2&&result('interrupt').stopLength===result('interrupt').observed.heartbeat&&!fs.existsSync(f.a+'/after-revoke'));
check('declared SDK version',version==='0.3.268');
save(out+'/claude-checks.json',checks);console.log(JSON.stringify({checks}));if(checks.some(c=>!c.ok))process.exitCode=1;
