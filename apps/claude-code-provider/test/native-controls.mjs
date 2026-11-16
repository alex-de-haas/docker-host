import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { UsageReader } from '@hosty/agent-provider-runtime/harness/provider-usage';
import { claudeUsage } from '../src/adapter/provider-usage.ts';
import { claudeContextUsage } from '../src/adapter/context-usage.ts';
const installed = process.env.HOSTY_TEST_PROVIDER_INSTALLED_CLI === '1';
test('installed Claude SDK metadata controls use an empty temporary account and submit no prompt', { skip: !installed, timeout: 60000 }, async () => {
  const { query, createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const home = await mkdtemp(path.join(os.tmpdir(), 'provider-claude-controls-'));
  let claude, finish;
  try {
    const prompt = (async function* () { await new Promise(resolve => { finish = resolve; }); })();
    claude = query({ prompt, options: { cwd: home, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, CLAUDE_CONFIG_DIR: home },
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
