import { checkPredictionProtocol } from './codex-prediction-native.mjs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { prepareNativeProfile } from '../src/worker/native.ts';
import { CodexLogin } from '../src/connections/codex-login.ts';
import assert from 'node:assert/strict';
import { UsageReader, claudeUsage } from '../src/harness/provider-usage.ts';
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
  const usageReader = new UsageReader(async () => claudeUsage(await claude.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true})));
  const usage = await usageReader.refresh(); usageReader.close();
  assert.equal(usage.state, 'unavailable'); assert.deepEqual(usage.rows, []);
  console.log('Claude missing-account usage is nonfatal; no prompt or transcript scan was submitted.');
  console.log('Claude native catalog, model/effort reset and context summary acknowledged without submitting a prompt.');
  codex = new CodexLogin(home); await codex.initialize();
  const catalog = await codex.request('model/list',{limit:100,includeHidden:false}); assert.ok(Array.isArray(catalog.data));
  const limits = await codex.request('account/rateLimits/read', {}).then(() => 'unexpected', () => 'unavailable');
  assert.equal(limits, 'unavailable');
  console.log('Codex missing-account limits are unavailable without creating a model turn.');
  console.log('Codex native model/effort catalog acknowledged without submitting a prompt.');
  await checkPredictionProtocol(home);
} finally {finish?.();claude?.close();await codex?.closeAndWait();await profile?.close();await rm(home,{recursive:true,force:true});}
