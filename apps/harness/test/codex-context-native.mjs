import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { CodexLogin } from '../src/connections/codex-login.ts';
import { readCodexMcpContext } from '../src/harness/codex-context.ts';

/** Real pinned binary and local stdio MCP, without credentials or a model turn. */
export async function checkContextProtocol(root) {
  const home = await mkdtemp(path.join(root, 'codex-context-'));
  let client;
  try {
    const fixture = path.join(home, 'mcp.mjs');
    await writeFile(fixture, `import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', line=>{
 const r=JSON.parse(line); if(r.id===undefined)return;
 const result=r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:
 r.method==='tools/list'?{tools:[{name:'inspect_original',description:'Private definition text',inputSchema:{type:'object',properties:{query:{type:'string'}}}}]}:{};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
});`);
    await writeFile(path.join(home, 'config.toml'), `[mcp_servers.context_fixture]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fixture)}]\n`);
    client = new CodexLogin(home); await client.initialize();
    const started = await client.request('thread/start', { cwd: home, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true });
    assert.ok(started.thread?.id);
    const result = await readCodexMcpContext(params => client.request('mcpServerStatus/list', { ...params, threadId: started.thread.id }), () => true);
    assert.equal(result.catalog.state, 'complete');
    assert.ok(result.mcp.tools.some(t => t.server === 'context_fixture' && t.name === 'inspect_original' && t.tokens > 0 && t.inclusion === 'unknown'));
    assert.ok(!JSON.stringify(result).includes('Private definition text'));
    console.log('PASS: pinned Codex thread-scoped MCP catalog yields local server/tool estimates without credentials or inference.');
  } finally { await client?.closeAndWait(); await rm(home, {recursive:true, force:true}); }
}
