import assert from "node:assert/strict";
import test from "node:test";

import {
  derivesPublicOrigins,
  INGRESS_PROVIDER_CLOUDFLARE_REMOTE,
  INGRESS_PROVIDER_CLOUDFLARED,
  INGRESS_PROVIDER_NONE,
  publishesThroughCloudflareApi,
} from "../src/app/shell/ingress.ts";
import { buildPublicOriginSettingKey, resolvePublishedLabelAction, sanitizeSubdomainLabel } from "../src/app/shell/public-origin.ts";

// The control renders one of three shapes and the provider picks it. Shell has no component-test
// harness, so what is pinned here is the extractable logic the shapes are chosen and validated by.

test("a subdomain label is reduced to what DNS accepts", () => {
  assert.equal(sanitizeSubdomainLabel("Media Server"), "mediaserver");
  assert.equal(sanitizeSubdomainLabel("MEDIA"), "media");
  assert.equal(sanitizeSubdomainLabel("my-app.example"), "my-appexample");
  assert.equal(sanitizeSubdomainLabel("réseau"), "rseau");
  assert.equal(sanitizeSubdomainLabel(""), "");
});

test("the three providers select three different shapes, and the selection is total", () => {
  // Exactly one of the two predicates is true per provider, and neither is true for `none` — which is
  // what makes "otherwise, a full URL the operator owns" a safe default rather than a fallthrough.
  const shapeOf = (provider) =>
    publishesThroughCloudflareApi(provider) ? "publish" : derivesPublicOrigins(provider) ? "subdomain" : "url";

  assert.equal(shapeOf(INGRESS_PROVIDER_CLOUDFLARE_REMOTE), "publish");
  assert.equal(shapeOf(INGRESS_PROVIDER_CLOUDFLARED), "subdomain");
  assert.equal(shapeOf(INGRESS_PROVIDER_NONE), "url");
  // A provider Core knows and Shell does not must not silently become a publish surface.
  assert.equal(shapeOf("something-new"), "url");
  assert.equal(shapeOf(undefined), "url");
  assert.equal(shapeOf(null), "url");
});

test("the control writes the same setting key Core reads for the endpoint", () => {
  // The manual shape saves through /configure, so an endpoint key that normalizes differently here than
  // in Core would write a setting nothing ever reads back.
  assert.equal(buildPublicOriginSettingKey("app.http"), "HOSTY_PUBLIC_ORIGIN_APP_HTTP");
  assert.equal(buildPublicOriginSettingKey("web-ui.https"), "HOSTY_PUBLIC_ORIGIN_WEB_UI_HTTPS");
});

test("an edited label on a published endpoint is a rename, not a second publish", () => {
  // The whole point of exposing this: Core's publish removes the old route in the same tunnel PUT and
  // renames the DNS record in place. Unpublish-then-publish, the only workaround while the field was
  // read-only, deletes the record and creates a new one.
  assert.deepEqual(resolvePublishedLabelAction("media", "cinema", "active"), { action: "rename", enabled: true });
  // A rename repairs a drifted route too — it writes the route with the endpoint's current local URL.
  assert.deepEqual(resolvePublishedLabelAction("media", "cinema", "origin_drifted"), { action: "rename", enabled: true });
  // Nothing to publish under: the verb stays "Rename" so the button is the affordance for the empty field
  // rather than something that appears only once a valid label is typed.
  assert.deepEqual(resolvePublishedLabelAction("media", "", "active"), { action: "rename", enabled: false });
  assert.deepEqual(resolvePublishedLabelAction("media", "   ", "active"), { action: "rename", enabled: false });
});

test("an unchanged label keeps Reapply's semantics, and only a drifted route has anything to press", () => {
  // Reapply is the repair the drift message asks for, and it must stay the same label: re-publishing under
  // it is idempotent for the hostname and the DNS record.
  assert.deepEqual(resolvePublishedLabelAction("media", "media", "origin_drifted"), { action: "reapply", enabled: true });
  // A healthy publication has nothing to reapply, so the disabled button names renaming instead — offering
  // a greyed-out repair would advertise a fix that is not needed and hide the affordance that is.
  for (const state of ["active", "app_stopped", "restart_required", "error"]) {
    assert.deepEqual(resolvePublishedLabelAction("media", "media", state), { action: "rename", enabled: false }, state);
  }
});

test("a label that only looks different is not a rename", () => {
  // Both sides go through the DNS-label sanitizer, so casing and whitespace the operator typed cannot make
  // an unchanged label read as an edit and fire a pointless remote mutation. Core normalizes identically.
  assert.deepEqual(resolvePublishedLabelAction("media", "MEDIA", "origin_drifted"), { action: "reapply", enabled: true });
  assert.deepEqual(resolvePublishedLabelAction("media", " media ", "active"), { action: "rename", enabled: false });
  assert.deepEqual(resolvePublishedLabelAction("media", "media.", "active"), { action: "rename", enabled: false });
});
