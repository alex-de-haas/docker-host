import assert from "node:assert/strict";
import test from "node:test";

import {
  derivesPublicOrigins,
  INGRESS_PROVIDER_CLOUDFLARE_REMOTE,
  INGRESS_PROVIDER_CLOUDFLARED,
  INGRESS_PROVIDER_NONE,
  publishesThroughCloudflareApi,
} from "../src/app/shell/ingress.ts";
import { buildPublicOriginSettingKey, sanitizeSubdomainLabel } from "../src/app/shell/public-origin.ts";

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
