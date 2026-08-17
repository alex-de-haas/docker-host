import assert from "node:assert/strict";
import test from "node:test";
import { appMayReceiveDelegatedToken } from "../src/app/shell/workspace/delegated-token-intent.ts";

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
