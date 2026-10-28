import { checkPredictionProtocol } from './codex-prediction-native.mjs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { prepareNativeProfile } from '../src/worker/native.ts';
import { CodexLogin } from '../src/connections/codex-login.ts';
import assert from 'node:assert/strict';
import { claudeContextUsage } from '../src/harness/context-usage.ts';
const home = await mkdtemp('/tmp/worker-controls-');
let profile, claude, codex, finish;
try {
  profile = await prepareNativeProfile(home, 'claude', 1000);
  const prompt = (async function*(){ await new Promise(resolve=>{finish=resolve;}); })();
  claude = query({prompt, options:{cwd:profile.root, env:{}, settingSources:[], persistSession:false, promptSuggestions:true, tools:[], mcpServers:{}, strictMcpConfig:true,
    pathToClaudeCodeExecutable:'/opt/hosty-worker/claude', spawnClaudeCodeProcess:args=>profile.transport.spawn('claude',args.args,{cwd:args.cwd ?? profile.root,env:args.env})}});
  const models = await claude.supportedModels(); assert.ok(Array.isArray(models));
  await claude.applyFlagSettings({model:null,effortLevel:null});
  const context = claudeContextUsage(await claude.getContextUsage({detail:'summary'}));
  assert.ok(context && context.usedTokens >= 0 && context.maxTokens > 0);
  console.log('Claude native catalog, model/effort reset and context summary acknowledged without submitting a prompt.');
  codex = new CodexLogin(home); await codex.initialize();
  const catalog = await codex.request('model/list',{limit:100,includeHidden:false}); assert.ok(Array.isArray(catalog.data));
  console.log('Codex native model/effort catalog acknowledged without submitting a prompt.');
  await checkPredictionProtocol(home);
} finally {finish?.();claude?.close();codex?.close();await profile?.close();await rm(home,{recursive:true,force:true});}
