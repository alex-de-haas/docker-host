// Manual protocol verification against pinned native binaries; only local fixtures, no account credentials.
// Run: npx tsx apps/ai-gateway/test/agent-directory-native.mts
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { McpProxy } from '../src/mcp/proxy.ts';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root=fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'');
const home=await mkdtemp(join(tmpdir(),'hosty-agent-native-'));
let toolsVersion=1; let streams:any[]=[]; const calls:string[]=[];
const upstream=createServer(async(req,res)=>{
 if(req.method==='GET'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': connected\n\n');streams.push(res);return;}
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');calls.push(body.method);
 if(body.id===undefined){res.writeHead(202).end();return;}
 const result=body.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:true}},serverInfo:{name:'fixture',version:'1'}}:body.method==='tools/list'?{tools:[{name:'tool_v'+toolsVersion,description:'Fixture',inputSchema:{type:'object',properties:{}}}]}:{};
 res.writeHead(200,{'content-type':'application/json','mcp-session-id':'fixture-session'});res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));const appUrl=`http://127.0.0.1:${(upstream.address() as any).port}/mcp`;
const proxy=new McpProxy(async()=>({token:'fixture-token',expiresAtMs:Date.now()+300000}),undefined,async()=>appUrl);
const key=proxy.register('spike',[{appId:'notes',url:appUrl}]);
const front=createServer((req,res)=>{void proxy.handle(req,res,new URL(req.url!,'http://x').pathname)});await new Promise<void>(r=>front.listen(0,'127.0.0.1',r));const proxyUrl=`http://127.0.0.1:${(front.address() as any).port}/internal/mcp/spike/notes`;
const model=createServer(async(req,res)=>{req.resume();res.writeHead(200,{'content-type':'text/event-stream'});const output=[{id:'msg_1',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'remembered fixture',annotations:[]}]}];
for(const event of [{type:'response.created',response:{id:'r1',object:'response',status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:output[0]},{type:'response.output_text.delta',item_id:'msg_1',output_index:0,content_index:0,delta:'remembered fixture'},{type:'response.output_item.done',output_index:0,item:output[0]},{type:'response.completed',response:{id:'r1',object:'response',status:'completed',output,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);res.end();});await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));const modelUrl=`http://127.0.0.1:${(model.address() as any).port}/v1`;
await writeFile(home+'/config.toml',`model = "fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "fixture"\nbase_url = "${modelUrl}"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
function boot(name:string){
 const child=spawn(process.execPath,[root+'/node_modules/@openai/codex/bin/codex.js','app-server','-c',`mcp_servers.${name}.url="${proxyUrl}"`,'-c',`mcp_servers.${name}.bearer_token_env_var="SPIKE_TOKEN"`],{cwd:home,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,SPIKE_TOKEN:key},stdio:['pipe','pipe','pipe']});
 let seq=0;const pending=new Map();const events:any[]=[];let err='';child.stderr.on('data',c=>err+=String(c));createInterface({input:child.stdout}).on('line',line=>{try{const m=JSON.parse(line);if(m.id!==undefined&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}else events.push(m);}catch{}});
 const request=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>reject(new Error('timeout '+method+' '+err.slice(-600))),20000);pending.set(id,{resolve:(x:any)=>{clearTimeout(timer);resolve(x)},reject:(e:any)=>{clearTimeout(timer);reject(e)}});child.stdin.write(JSON.stringify({id,method,params})+'\n')});
 return {child,request,events,notify:(method:string)=>child.stdin.write(JSON.stringify({method})+'\n'),stop:async()=>{child.kill();await new Promise(r=>child.once('exit',r));}};
}
let run:any;
try{
 run=boot('first');await run.request('initialize',{clientInfo:{name:'hosty-spike',version:'1'}});run.notify('initialized');
 const first=await run.request('thread/start',{cwd:home,sandbox:'read-only',approvalPolicy:'never'});const id=first.thread.id;
 await run.request('turn/start',{threadId:id,input:[{type:'text',text:'Remember marker HOSTY_DIRECTORY_SPIKE_42'}]});
 const until=Date.now()+20000;while(!run.events.some((e:any)=>e.method==='turn/completed')&&Date.now()<until)await new Promise(r=>setTimeout(r,50));
 console.log('Codex initial MCP tools', (await run.request('mcpServerStatus/list',{})).data.map((x:any)=>({name:x.name,tools:Object.keys(x.tools)}))); 
 const before=calls.filter(m=>m==='tools/list').length;toolsVersion=2;for(const s of streams)s.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');await new Promise(r=>setTimeout(r,1500));
 console.log('codex_notification',{streams:streams.length,listsBefore:before,listsAfter:calls.filter(m=>m==='tools/list').length,status:(await run.request('mcpServerStatus/list',{})).data.map((x:any)=>({name:x.name,tools:Object.keys(x.tools)}))});
 await run.stop();run=boot('second');await run.request('initialize',{clientInfo:{name:'hosty-spike',version:'1'}});run.notify('initialized');
 const resumed=await run.request('thread/resume',{threadId:id});
 assert.equal(resumed.thread.id,id);
 assert.ok(JSON.stringify(resumed.thread.turns).includes('HOSTY_DIRECTORY_SPIKE_42'));
 assert.ok(JSON.stringify(resumed.thread.turns).includes('remembered fixture'));
 const after=await run.request('mcpServerStatus/list',{});
 assert.equal(after.data[0].name,'second'); assert.ok(after.data[0].tools.tool_v2);
 console.log('Codex resume: same conversation, new server, new tools — PASS');
 await run.stop();run=null;
 toolsVersion=1;streams=[];
 const q=query({prompt:(async function*(){await new Promise(()=>{});})(),options:{cwd:home,settingSources:[],env:{PATH:process.env.PATH,HOME:home,ANTHROPIC_API_KEY:'fixture-key',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},mcpServers:{first:{type:'http',url:proxyUrl,headers:{Authorization:'Bearer '+key}}}}});
 void (async()=>{try{for await(const _ of q){}}catch{}})();
 try {
   for(let i=0;i<100;i++){if((await q.mcpServerStatus()).every(x=>x.status==='connected'))break;await new Promise(r=>setTimeout(r,50));}
   const before=calls.filter(m=>m==='tools/list').length;toolsVersion=2;
   for(const stream of streams)stream.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
   await new Promise(r=>setTimeout(r,1500));
   assert.ok(calls.filter(m=>m==='tools/list').length>before);
   const status=await q.mcpServerStatus();assert.ok(status[0].tools?.some(t=>t.name==='tool_v2'));
   const changed=await q.setMcpServers({second:{type:'http',url:proxyUrl,headers:{Authorization:'Bearer '+key}}});
   assert.deepEqual(changed.errors,{});
   await q.toggleMcpServer('first',false);
   const updated=await q.mcpServerStatus();
   assert.equal(updated.find(x=>x.name==='first')?.status,'disabled');
   assert.equal(updated.find(x=>x.name==='second')?.status,'connected');
   console.log('Claude list_changed, add server, disable startup server — PASS');
 } finally {q.close();}

}catch(e){console.error('spike_failure',e);process.exitCode=1;}
finally{if(run)await run.stop().catch(()=>{});for(const s of streams)s.end();front.closeAllConnections();upstream.closeAllConnections();model.closeAllConnections();front.close();upstream.close();model.close();await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
