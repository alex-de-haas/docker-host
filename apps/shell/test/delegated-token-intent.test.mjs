import assert from "node:assert/strict";
import test from "node:test";
import {
  appMayReceiveDelegatedToken,
  createDelegatedTokenCache,
} from "../src/app/shell/workspace/delegated-token-intent.ts";

// A mint stand-in: hands out token-1, token-2, … and records how often Core would have been called.
function stubMint(expiresInMs = 300_000, now = () => Date.now()) {
  let minted = 0;
  const calls = [];
  let release = null;
  const mint = (appId) => {
    minted += 1;
    calls.push(appId);
    const grant = { token: `token-${minted}`, expiresAt: new Date(now() + expiresInMs).toISOString() };
    return release ? new Promise((resolve) => release.push(() => resolve(grant))) : Promise.resolve(grant);
  };
  return {
    mint,
    calls,
    /** Defers every following mint until `flush()`, so an in-flight window can be observed. */
    hold() {
      release = [];
    },
    flush() {
      const pending = release ?? [];
      release = null;
      for (const resolve of pending) resolve();
    },
  };
}

// The verified parser is the SDK's (covered by its own suite); what Shell owns, and what this
// covers, is which frame gets answered at all.
test("appMayReceiveDelegatedToken admits the installed assistant gateway and nothing else", () => {
  assert.equal(appMayReceiveDelegatedToken("hosty.ai-gateway", "hosty.ai-gateway"), true);
  // The grant follows the ai-gateway interface, not an id, so a replacement assistant inherits it.
  assert.equal(appMayReceiveDelegatedToken("com.example.assistant", "com.example.assistant"), true);
  assert.equal(appMayReceiveDelegatedToken("hosty.marketplace", "hosty.ai-gateway"), false);
  assert.equal(appMayReceiveDelegatedToken("com.example.app", "hosty.ai-gateway"), false);
  // No gateway installed: no app is the assistant, so no frame is answered.
  assert.equal(appMayReceiveDelegatedToken("hosty.ai-gateway", undefined), false);
  assert.equal(appMayReceiveDelegatedToken(undefined, undefined), false);
});

test("the cache reuses a live grant and mints again once it is nearly spent", async () => {
  let clock = 1_000_000;
  const core = stubMint(300_000, () => clock);
  const cache = createDelegatedTokenCache(core.mint, { minRemainingMs: 30_000, now: () => clock });

  assert.equal((await cache.issue("hosty.ai-gateway")).token, "token-1");
  assert.equal((await cache.issue("hosty.ai-gateway")).token, "token-1");
  assert.deepEqual(core.calls, ["hosty.ai-gateway"]);

  // A different app never shares a grant — the token names its audience.
  assert.equal((await cache.issue("com.example.other")).token, "token-2");

  // Inside the margin the grant is treated as spent, even though it has not formally expired.
  clock += 280_000;
  assert.equal((await cache.issue("hosty.ai-gateway")).token, "token-3");
});

test("a refused token is never replayed, and concurrent asks share one mint", async () => {
  const core = stubMint();
  const cache = createDelegatedTokenCache(core.mint);

  assert.equal((await cache.issue("app")).token, "token-1");
  // The app was refused while its grant still looks fresh here — two clocks need not agree on
  // "expired". Without honouring refresh, every retry would replay the token the API just rejected.
  assert.equal((await cache.issue("app", true)).token, "token-2");
  assert.equal(core.calls.length, 2);

  core.hold();
  const both = Promise.all([cache.issue("app", true), cache.issue("app", true)]);
  core.flush();
  const [first, second] = await both;
  assert.equal(first.token, second.token);
  assert.equal(core.calls.length, 3, "parallel requests must not race into two mints");
});

test("a mint that outlives its session is discarded, not cached", async () => {
  const core = stubMint();
  const cache = createDelegatedTokenCache(core.mint);

  core.hold();
  const inFlight = cache.issue("app");
  // The signed-in user changes while Core is still minting.
  cache.invalidateAll();
  core.flush();
  await assert.rejects(inFlight, /signed-in user changed/);

  // And nothing from the old session survives in the cache for the new one to pick up.
  const after = await cache.issue("app");
  assert.equal(after.token, "token-2");
});
