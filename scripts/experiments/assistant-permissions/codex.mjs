import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {args,requireArgs,fixture,cleanEnv,delay,save,rpcChild} from './common.mjs';
requireArgs();const out=path.resolve(args.out),f=fixture(out),home=out+'/codex-home';fs.mkdirSync(home,{recursive:true});fs.mkdirSync(out+'/process-tmp',{recursive:true});
const cli=path.resolve(args.deps,'node_modules/@openai/codex/bin/codex.js');
const version=JSON.parse(fs.readFileSync(path.resolve(args.deps,'node_modules/@openai/codex/package.json'))).version;
const profiles={};
for(const [name,edit,second]of [['both',true,true],['a-only',true,false],['readonly',false,false]]){
 profiles[name]={filesystem:{':minimal':'read','/System/Library/OpenSSL':'read',[f.a]:edit?'write':'read',[f.b]:second?'write':'read',[f.c]:'read',[f.cache]:'write',[f.secret]:'deny',':tmpdir':'read',':slash_tmp':'deny'},network:{enabled:false}};
}
let script=[],index=0;const requests=[];
const server=http.createServer(async(req,res)=>{
 let body='';for await(const d of req)body+=d;
 if(!req.url.includes('/responses')){res.writeHead(404);res.end('{}');return;}
 const request=JSON.parse(body);requests.push({url:req.url,tools:request.tools,input:request.input});
 const action=script[index++];
 const output=action?[{id:'fc_'+index,type:action.type??'function_call',call_id:'fixture_'+index,name:action.name,...(action.type==='custom_tool_call'?{input:action.input}:{arguments:JSON.stringify(action.arguments)}),status:'completed'}]:[{id:'msg_'+index,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Fixture complete.',annotations:[]}]}];
 const response={id:'resp_'+requests.length,object:'response',created_at:1789570000,status:'completed',model:request.model,output,usage:{input_tokens:10,output_tokens:10,total_tokens:20}};
 res.writeHead(200,{'Content-Type':'text/event-stream'});let seq=0;
 const emit=(type,data)=>res.write('data: '+JSON.stringify({type,sequence_number:seq++,...data})+'\n\n');
 emit('response.created',{response:{...response,status:'in_progress',output:[]}});
 for(const [output_index,item]of output.entries()){
  emit('response.output_item.added',{output_index,item:item.type==='function_call'?{...item,arguments:'',status:'in_progress'}:item.type==='custom_tool_call'?{...item,input:'',status:'in_progress'}:{...item,content:[],status:'in_progress'}});
  if(item.type==='function_call'){
   emit('response.function_call_arguments.delta',{item_id:item.id,output_index,delta:item.arguments});
   emit('response.function_call_arguments.done',{item_id:item.id,output_index,arguments:item.arguments});
  }else if(item.type==='custom_tool_call'){
   emit('response.custom_tool_call_input.delta',{item_id:item.id,output_index,delta:item.input});
   emit('response.custom_tool_call_input.done',{item_id:item.id,output_index,input:item.input});
  }else emit('response.output_text.delta',{item_id:item.id,output_index,content_index:0,delta:'Fixture complete.'});
  emit('response.output_item.done',{output_index,item});
 }
 emit('response.completed',{response});res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/v1`;
const catalog=path.join(path.dirname(new URL(import.meta.url).pathname),'model-catalog.json');
let config=`default_permissions = "readonly"\nproject_doc_max_bytes = 0\nmodel = "hosty-permission-fixture"\nmodel_catalog_json = ${JSON.stringify(catalog)}\nmodel_provider = "fixture"\napproval_policy = "never"\n[model_providers.fixture]\nname = "Local fixture"\nbase_url = ${JSON.stringify(base)}\nwire_api = "responses"\nrequires_openai_auth = false\n`;
for(const [name,p]of Object.entries(profiles)){
 config+=`\n[permissions.${JSON.stringify(name)}.filesystem]\n`;
 for(const[k,v]of Object.entries(p.filesystem))config+=`${JSON.stringify(k)} = ${JSON.stringify(v)}\n`;
 config+=`[permissions.${JSON.stringify(name)}.network]\nenabled = false\n`;
}
fs.writeFileSync(home+'/config.toml',config);
let client;
async function connect(){const c=rpcChild(process.execPath,[cli,'app-server','--stdio'],{cwd:f.a,env:cleanEnv({CODEX_HOME:home,TMPDIR:out+'/process-tmp'})});await c.rpc('initialize',{clientInfo:{name:'hosty-permission-fixture',version:'1'},capabilities:{experimentalApi:true}});c.send({method:'initialized',params:{}});return c;}
const results=[];function record(name,result){results.push({name,result});save(out+'/codex-results.json',{version,results,requests,events:client?.events});console.log(JSON.stringify({name,result}));}
const code=`const fs=require('fs');const o={};for(const[k,p]of Object.entries(${JSON.stringify({a:f.a,b:f.b,c:f.c,cache:f.cache})})){try{fs.writeFileSync(p+'/probe','x');o[k]='allowed'}catch(e){o[k]=e.code}}for(const[k,p]of Object.entries(${JSON.stringify({secret:f.secret+'/token.txt',symlink:f.a+'/secret-link/token.txt',public:f.a+'/public.txt'})})){try{o[k]=fs.readFileSync(p,'utf8')}catch(e){o[k]=e.code}}console.log(JSON.stringify(o));`;
const cmd={command:[process.execPath,'-e',code],cwd:f.a,timeoutMs:10000};
const patch=(name,target=f.a)=>({type:'custom_tool_call',name:'apply_patch',input:`*** Begin Patch\n*** Add File: ${target}/${name}\n+fixture\n*** End Patch`});
async function turn(threadId,actions,extra={},interruptFile){
 script=actions;index=0;let resolve;const completed=new Promise(r=>resolve=r);
 const listener=m=>{if(m.method==='turn/completed'&&m.params.threadId===threadId)resolve(m.params.turn)};client.listeners.add(listener);
 const timer=setTimeout(()=>resolve({status:'timeout'}),30000);
 let watcher,interrupted=false;
 try{
  const started=await client.rpc('turn/start',{threadId,input:[{type:'text',text:'Execute the synthetic fixture sequence.',text_elements:[]}],...extra});
  if(interruptFile)watcher=setInterval(()=>{if(!interrupted&&fs.existsSync(interruptFile)&&fs.statSync(interruptFile).size>=2){interrupted=true;client.rpc('turn/interrupt',{threadId,turnId:started.turn.id}).catch(()=>{});}},20);
  const result=await completed;
  const outputs=requests.at(-1)?.input?.filter(x=>['function_call_output','custom_tool_call_output'].includes(x.type)).slice(-actions.length)??[];
  return {...result,toolOutputs:outputs};
 }finally{clearTimeout(timer);clearInterval(watcher);client.listeners.delete(listener);}
}
try{
 client=await connect();
 for(const permissionProfile of ['both','a-only','readonly'])record('command-'+permissionProfile,await client.rpc('command/exec',{...cmd,permissionProfile}));
 const heartbeat=f.a+'/heartbeat';
 const pending=client.rpc('command/exec',{command:[process.execPath,'-e',`const fs=require('fs');let n=0;const t=setInterval(()=>{fs.appendFileSync(${JSON.stringify(heartbeat)},'x');if(++n===40)clearInterval(t)},100)`],cwd:f.a,permissionProfile:'both',processId:'heartbeat',timeoutMs:10000});
 for(let n=0;n<60&&(!fs.existsSync(heartbeat)||fs.statSync(heartbeat).size<2);n++)await delay(50);
 await client.rpc('command/exec/terminate',{processId:'heartbeat'});await pending;
 const stopped=fs.existsSync(heartbeat)?fs.statSync(heartbeat).size:0;await delay(1200);
 record('terminate',{stopped,after:fs.existsSync(heartbeat)?fs.statSync(heartbeat).size:0});
 const t=await client.rpc('thread/start',{cwd:f.a,permissions:'both',approvalPolicy:'never',baseInstructions:'Run only the scripted fixture tools. No external services.',config:{'features.shell_snapshot':false}});
 const actions=[{name:'exec_command',arguments:{cmd:`${JSON.stringify(process.execPath)} -e ${"'"+code.replaceAll("'","'\\''")+"'"}`,workdir:f.a,max_output_tokens:1000}}];
 record('thread-both',await turn(t.thread.id,actions));
 client.stop();await delay(300);client=await connect();
 const resumed=await client.rpc('thread/resume',{threadId:t.thread.id,cwd:f.a,permissions:'a-only',approvalPolicy:'never'});
 record('resume-policy',{permissions:resumed.permissions,sandbox:resumed.sandbox,threadId:resumed.thread.id});
 record('thread-resumed-a-only',await turn(t.thread.id,actions));
 const editThread=await client.rpc('thread/start',{cwd:f.a,permissions:'both',approvalPolicy:'never',config:{'features.shell_tool':false,'features.unified_exec':false,'features.shell_snapshot':false}});
 record('edit-only',await turn(editThread.thread.id,[patch('edit-only'),{name:'exec_command',arguments:{cmd:`touch ${f.a}/edit-only-command`,workdir:f.a}}]));
 const commandThread=await client.rpc('thread/start',{cwd:f.a,permissions:'readonly',approvalPolicy:'never',config:{'features.shell_snapshot':false}});
 record('command-only',await turn(commandThread.thread.id,[patch('command-only'),...actions]));
 const neither=await client.rpc('thread/start',{cwd:f.a,permissions:'readonly',approvalPolicy:'never',config:{'features.shell_tool':false,'features.unified_exec':false,'features.shell_snapshot':false}});
 record('neither',await turn(neither.thread.id,[patch('neither'),...actions]));
 record('file-tool-secret',await turn(editThread.thread.id,[{type:'custom_tool_call',name:'apply_patch',input:`*** Begin Patch\n*** Update File: ${f.secret}/token.txt\n@@\n-SYNTHETIC_SECRET_DO_NOT_DISCLOSE\n+changed\n*** End Patch`}]));
 const running=await client.rpc('thread/start',{cwd:f.a,permissions:'both',approvalPolicy:'never',config:{'features.shell_snapshot':false}});
 const nativeHeartbeat=f.a+'/native-heartbeat',nativeProbe=f.a+'/native-heartbeat.cjs';
 fs.writeFileSync(nativeProbe,`const fs=require('fs');let n=0;const t=setInterval(()=>{fs.appendFileSync(${JSON.stringify(nativeHeartbeat)},'x');if(++n===40)clearInterval(t)},100);`);
 record('turn-interrupt',await turn(running.thread.id,[{name:'exec_command',arguments:{cmd:`${JSON.stringify(process.execPath)} ${JSON.stringify(nativeProbe)}`,workdir:f.a,yield_time_ms:10000}},patch('after-native-revoke')],{},nativeHeartbeat));
 if(args.revoke==='unsubscribe')record('unsubscribe',await client.rpc('thread/unsubscribe',{threadId:running.thread.id}));
 const atStop=fs.existsSync(nativeHeartbeat)?fs.statSync(nativeHeartbeat).size:0;await delay(1200);
 record('turn-quiescence',{atStop,after:fs.existsSync(nativeHeartbeat)?fs.statSync(nativeHeartbeat).size:0,nextFile:fs.existsSync(f.a+'/after-native-revoke')});
 if(args.revoke==='unsubscribe')await client.rpc('thread/resume',{threadId:running.thread.id,cwd:f.a,permissions:'a-only',approvalPolicy:'never'});
 record('turn-after-revoke',await turn(running.thread.id,actions,{permissions:'a-only'}));
 record('observed-files',{editOnly:fs.existsSync(f.a+'/edit-only'),commandEscaped:fs.existsSync(f.a+'/edit-only-command'),commandOnly:fs.existsSync(f.a+'/command-only'),neither:fs.existsSync(f.a+'/neither'),secret:fs.readFileSync(f.secret+'/token.txt','utf8')});
}catch(error){record('error',String(error));process.exitCode=1}finally{save(out+'/codex-results.json',{version,results,requests,events:client?.events,stderr:client?.stderr});client?.stop();server.closeAllConnections();server.close();}
const checks=[];
const check=(name,ok)=>checks.push({name,ok:Boolean(ok)});
const result=name=>results.find(r=>r.name===name)?.result;
for(const [name,a,b]of [['both','allowed','allowed'],['a-only','allowed','EPERM'],['readonly','EPERM','EPERM']]){
 const r=result('command-'+name);let p;try{p=JSON.parse(r.stdout)}catch{}
 check(name+' executes',r?.exitCode===0);check(name+' writes',p?.a===a&&p?.b===b&&p?.c==='EPERM'&&p?.cache==='allowed');check(name+' reads',p?.secret==='EPERM'&&p?.symlink==='EPERM'&&p?.public==='public fixture\n');
}
check('source edits without shell',result('observed-files')?.editOnly&&!result('observed-files')?.commandEscaped);
check('commands without edits',!result('observed-files')?.commandOnly);
check('neither permission',!result('observed-files')?.neither);
check('patch secret blocked',JSON.stringify(result('file-tool-secret')?.toolOutputs).includes('Operation not permitted'));
check('resume narrows B',JSON.stringify(result('thread-resumed-a-only')?.toolOutputs).includes('\\"b\\":\\"EPERM\\"'));
check('direct process quiescent',result('terminate')?.stopped>=2&&result('terminate')?.stopped===result('terminate')?.after);
check('turn quiescent',result('turn-interrupt')?.status==='interrupted'&&result('turn-quiescence')?.atStop>=2&&result('turn-quiescence')?.atStop===result('turn-quiescence')?.after&&!result('turn-quiescence')?.nextFile);
check('revoked B after interrupt',JSON.stringify(result('turn-after-revoke')?.toolOutputs).includes('\\"b\\":\\"EPERM\\"'));
check('config accepted',!client?.stderr.join('').includes('Invalid configuration'));
check('declared CLI version',version==='0.154.0');
save(out+'/codex-checks.json',checks);console.log(JSON.stringify({checks}));if(checks.some(c=>!c.ok))process.exitCode=1;
