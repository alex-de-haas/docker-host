import assert from "node:assert/strict";
import test from "node:test";
import {
  derivesPublicOrigins,
  INGRESS_PROVIDER_CLOUDFLARE_REMOTE,
  INGRESS_PROVIDER_CLOUDFLARED,
  INGRESS_PROVIDER_NONE,
  isIngressSettingVisible,
  publishesThroughCloudflareApi,
} from "../src/app/shell/ingress.ts";

test("publishing belongs to the API provider and to nothing else", () => {
  // The two Cloudflare providers are mutually exclusive. Offering the publish control under the
  // local-config one is what let a published label be overwritten by the derived hostname on the next
  // start, and Core now refuses that publish outright.
  assert.equal(publishesThroughCloudflareApi(INGRESS_PROVIDER_CLOUDFLARE_REMOTE), true);
  assert.equal(publishesThroughCloudflareApi(INGRESS_PROVIDER_CLOUDFLARED), false);
  assert.equal(publishesThroughCloudflareApi(INGRESS_PROVIDER_NONE), false);
  // Status not loaded yet: no provider is not the API provider.
  assert.equal(publishesThroughCloudflareApi(undefined), false);
  assert.equal(publishesThroughCloudflareApi(null), false);
});

test("only the local-config provider derives public origins", () => {
  assert.equal(derivesPublicOrigins(INGRESS_PROVIDER_CLOUDFLARED), true);
  assert.equal(derivesPublicOrigins(INGRESS_PROVIDER_CLOUDFLARE_REMOTE), false);
  assert.equal(derivesPublicOrigins(INGRESS_PROVIDER_NONE), false);
  assert.equal(derivesPublicOrigins(undefined), false);
});

test("the tunnel fields belong to the local-config provider alone", () => {
  // A remotely managed tunnel is discovered by connecting and its zone supplies the base domain, so
  // showing these three would ask the operator for values that are never read.
  for (const key of ["HOSTY_INGRESS_BASE_DOMAIN", "HOSTY_INGRESS_TUNNEL_ID", "HOSTY_INGRESS_CREDENTIALS_FILE"]) {
    assert.equal(isIngressSettingVisible(key, INGRESS_PROVIDER_CLOUDFLARED), true, key);
    assert.equal(isIngressSettingVisible(key, INGRESS_PROVIDER_CLOUDFLARE_REMOTE), false, key);
    assert.equal(isIngressSettingVisible(key, INGRESS_PROVIDER_NONE), false, key);
  }
});

test("the provider selector itself is always visible", () => {
  for (const provider of [INGRESS_PROVIDER_NONE, INGRESS_PROVIDER_CLOUDFLARE_REMOTE, INGRESS_PROVIDER_CLOUDFLARED]) {
    assert.equal(isIngressSettingVisible("HOSTY_INGRESS_PROVIDER", provider), true, provider);
  }
});
