import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { CodexLogin, cleanAgentEnvironment } from '../src/internal/connections/codex-login.ts';
import { UsageReader, claudeUsage } from '../src/internal/harness/provider-usage.ts';
import { claudeContextUsage } from '../src/internal/harness/context-usage.ts';
import { checkContextProtocol } from './codex-context-native.mjs';
import { checkPredictionProtocol } from './codex-prediction-native.mjs';

const installed = process.env.HOSTY_TEST_PROVIDER_INSTALLED_CLI === '1';
test(`${installed ? 'installed' : 'injected fake'} Codex metadata/context/prediction controls submit no model turn`, { timeout: 60000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'provider-controls-'));
  const previous = process.env.HOSTY_HARNESS_CODEX_COMMAND;
  let client;
  try {
    if (!installed) process.env.HOSTY_HARNESS_CODEX_COMMAND = fileURLToPath(new URL('./fake-codex-native-controls.mjs', import.meta.url));
    client = new CodexLogin(home); await client.initialize();
    assert.ok(Array.isArray((await client.request('model/list', { limit: 100, includeHidden: false })).data));
    assert.equal(await client.request('account/rateLimits/read', {}).then(() => 'unexpected', () => 'unavailable'), 'unavailable');
    await client.closeAndWait(); client = undefined;
    await checkPredictionProtocol(home, { fake: !installed });
    await checkContextProtocol(home, { fake: !installed });
    if (!installed) {
      const methods = (await readFile(path.join(home, 'native-control-methods.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).method);
      assert.ok(methods.includes('model/list')); assert.ok(methods.includes('thread/prediction/request'));
      assert.equal(methods.some(method => method === 'turn/start' || method.startsWith('account/login')), false);
    }
  } finally {
    await client?.closeAndWait(); await rm(home, { recursive: true, force: true });
    if (previous === undefined) delete process.env.HOSTY_HARNESS_CODEX_COMMAND; else process.env.HOSTY_HARNESS_CODEX_COMMAND = previous;
  }
});

test('installed Claude SDK metadata controls use an empty temporary account and submit no prompt', { skip: !installed, timeout: 60000 }, async () => {
  const { query, createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const home = await mkdtemp(path.join(os.tmpdir(), 'provider-claude-controls-'));
  let claude, finish;
  try {
    const prompt = (async function* () { await new Promise(resolve => { finish = resolve; }); })();
    claude = query({ prompt, options: { cwd: home, env: { ...cleanAgentEnvironment(), HOME: home, CLAUDE_CONFIG_DIR: home },
      settingSources: [], persistSession: false, promptSuggestions: true, tools: [], strictMcpConfig: true,
      mcpServers: { 'context-fixture': createSdkMcpServer({ name: 'context-fixture', tools: [tool('inspect', 'Read synthetic status', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }))] }) } } });
    assert.ok(Array.isArray(await claude.supportedModels()));
    await claude.applyFlagSettings({ model: null, effortLevel: null });
    const context = claudeContextUsage(await claude.getContextUsage({ detail: 'summary' }));
    assert.ok(context && context.usedTokens >= 0 && context.maxTokens > 0);
    assert.ok(context.mcp?.tools.some(value => value.server === 'context-fixture' && value.name.includes('inspect') && value.tokens >= 0));
    const reader = new UsageReader(async () => claudeUsage(await claude.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })));
    try { const usage = await reader.refresh(); assert.equal(usage.state, 'unavailable'); assert.deepEqual(usage.rows, []); } finally { reader.close(); }
  } finally { finish?.(); claude?.close(); await rm(home, { recursive: true, force: true }); }
});
