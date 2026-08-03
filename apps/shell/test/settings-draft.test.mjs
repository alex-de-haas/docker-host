import assert from "node:assert/strict";
import test from "node:test";
import { buildAppSettingsDraft, buildAppSettingsPayload, resolveSecretFieldState } from "../src/app/shell/settings-draft.ts";

// Minimal CoreSetting shape the draft helpers read.
function setting(key, overrides = {}) {
  return { key, type: "string", secret: false, ...overrides };
}

function secret(key, hasValue) {
  return { key, type: "string", secret: true, hasValue, value: null };
}

test("the draft seeds plain settings from their stored value and secrets as untouched", () => {
  const draft = buildAppSettingsDraft([
    setting("PORT", { value: "8080" }),
    setting("MODE", { value: null }),
    secret("API_KEY", true),
    secret("TOKEN", false),
  ]);

  assert.deepEqual(draft, { PORT: "8080", MODE: "", API_KEY: null, TOKEN: null });
});

test("an untouched secret stays out of the payload so Core keeps the stored value", () => {
  const settings = [setting("PORT", { value: "8080" }), secret("API_KEY", true)];
  const payload = buildAppSettingsPayload(settings, buildAppSettingsDraft(settings));

  assert.deepEqual(payload, { PORT: "8080" });
  assert.equal("API_KEY" in payload, false);
});

test("an emptied secret is submitted as an empty string, which is what clears it", () => {
  const settings = [secret("API_KEY", true)];
  const payload = buildAppSettingsPayload(settings, { API_KEY: "" });

  assert.deepEqual(payload, { API_KEY: "" });
});

test("a retyped secret is submitted verbatim", () => {
  const settings = [secret("API_KEY", true)];

  assert.deepEqual(buildAppSettingsPayload(settings, { API_KEY: "next" }), { API_KEY: "next" });
});

test("a plain setting is always submitted, empty included", () => {
  const settings = [setting("PORT"), setting("MODE")];
  const payload = buildAppSettingsPayload(settings, { PORT: "", MODE: "fast" });

  assert.deepEqual(payload, { PORT: "", MODE: "fast" });
});

test("a setting missing from the draft falls back to empty rather than undefined", () => {
  const payload = buildAppSettingsPayload([setting("PORT")], {});

  assert.deepEqual(payload, { PORT: "" });
});

test("a secret missing from the draft is treated as untouched, not as a clear", () => {
  const payload = buildAppSettingsPayload([secret("API_KEY", true)], {});

  assert.deepEqual(payload, {});
});

test("the payload carries only declared settings, never stray draft keys", () => {
  const payload = buildAppSettingsPayload([setting("PORT")], { PORT: "80", GONE: "stale" });

  assert.deepEqual(payload, { PORT: "80" });
});

// The reported bug, as a sequence: reveal a stored secret, then delete what it shows.
test("deleting a revealed secret leaves the field empty instead of restoring the value", () => {
  const stored = "s3cret";

  // Revealed and untouched: the stored value stands in.
  const revealedState = resolveSecretFieldState({ draftValue: null, hasStored: true, revealed: true, stored });
  assert.equal(revealedState.displayValue, stored);

  // Backspacing through it -- the last step is the one that used to snap the whole value back.
  for (const typed of ["s3cre", "s3c", "s", ""]) {
    const state = resolveSecretFieldState({ draftValue: typed, hasStored: true, revealed: true, stored });
    assert.equal(state.displayValue, typed);
  }

  // Select-all + Delete reaches the empty draft in one step, and it stays empty too.
  assert.equal(resolveSecretFieldState({ draftValue: "", hasStored: true, revealed: true, stored }).displayValue, "");
});

test("an emptied secret says it will be cleared rather than promising it is unchanged", () => {
  const clearing = resolveSecretFieldState({ draftValue: "", hasStored: true, revealed: true, stored: "s3cret" });

  assert.equal(clearing.placeholder, "Will be cleared on save");
});

test("an untouched secret reads Unchanged when stored and Not set when never configured", () => {
  const untouched = { draftValue: null, revealed: false, stored: null };

  assert.equal(resolveSecretFieldState({ ...untouched, hasStored: true }).placeholder, "Unchanged");
  assert.equal(resolveSecretFieldState({ ...untouched, hasStored: false }).placeholder, "Not set");
});

test("an install-time secret with nothing stored reads Not set even once typed", () => {
  const state = resolveSecretFieldState({ draftValue: "typed", hasStored: false, revealed: true, stored: null });

  assert.equal(state.displayValue, "typed");
  assert.equal(state.placeholder, "Not set");
});

test("an untouched secret hides its stored value until revealed", () => {
  const hidden = resolveSecretFieldState({ draftValue: null, hasStored: true, revealed: false, stored: "s3cret" });

  assert.equal(hidden.displayValue, "");
});

test("the stored value is fetched once, and never for a field the operator has touched", () => {
  const untouched = { draftValue: null, revealed: false };

  assert.equal(resolveSecretFieldState({ ...untouched, hasStored: true, stored: null }).shouldFetchStored, true);
  // Already in hand, so a single reveal cannot fetch twice. Hiding drops the plaintext, so the reveal
  // after that legitimately fetches again -- this is not a cache.
  assert.equal(resolveSecretFieldState({ ...untouched, hasStored: true, stored: "s3cret" }).shouldFetchStored, false);
  // Nothing stored to fetch.
  assert.equal(resolveSecretFieldState({ ...untouched, hasStored: false, stored: null }).shouldFetchStored, false);
  // Touched -- including the emptied field, which must not be refilled behind the operator's back.
  assert.equal(resolveSecretFieldState({ draftValue: "", revealed: false, hasStored: true, stored: null }).shouldFetchStored, false);
  assert.equal(resolveSecretFieldState({ draftValue: "typed", revealed: false, hasStored: true, stored: null }).shouldFetchStored, false);
});

// The end-to-end shape of the fix: what the operator did in the field decides what Core is sent.
test("the emptied field produces a payload that clears the secret", () => {
  const settings = [secret("API_KEY", true)];
  const draft = buildAppSettingsDraft(settings);

  // Untouched: nothing to send, the stored value survives.
  assert.deepEqual(buildAppSettingsPayload(settings, draft), {});

  // Revealed and emptied by the operator.
  const cleared = { ...draft, API_KEY: resolveSecretFieldState({ draftValue: "", hasStored: true, revealed: true, stored: "s3cret" }).displayValue };
  assert.deepEqual(buildAppSettingsPayload(settings, cleared), { API_KEY: "" });
});
