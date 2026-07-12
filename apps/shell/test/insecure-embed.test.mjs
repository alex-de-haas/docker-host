import assert from "node:assert/strict";
import test from "node:test";
import {
  getEmbedOrigin,
  isInsecureEmbedBlocked,
  isLoopbackEmbedHost,
} from "../src/app/shell/workspace/insecure-embed.ts";

test("isInsecureEmbedBlocked blocks http app URLs inside an https Shell", () => {
  assert.equal(isInsecureEmbedBlocked("https:", "http://127.0.0.1:60944/metrics?code=abc"), true);
  assert.equal(isInsecureEmbedBlocked("https:", "http://localhost:3000/"), true);
  assert.equal(isInsecureEmbedBlocked("https:", "http://apps.example.com/ui"), true);
});

test("isInsecureEmbedBlocked allows https app URLs and any URL on an http Shell", () => {
  assert.equal(isInsecureEmbedBlocked("https:", "https://telemetry.example.com/metrics"), false);
  assert.equal(isInsecureEmbedBlocked("http:", "http://127.0.0.1:60944/metrics"), false);
  assert.equal(isInsecureEmbedBlocked("http:", "https://telemetry.example.com/metrics"), false);
});

test("isInsecureEmbedBlocked treats non-absolute src as same-origin (never mixed content)", () => {
  assert.equal(isInsecureEmbedBlocked("https:", "/marketplace"), false);
  assert.equal(isInsecureEmbedBlocked("https:", ""), false);
});

test("getEmbedOrigin extracts the origin and falls back to the raw value", () => {
  assert.equal(getEmbedOrigin("http://127.0.0.1:60944/metrics?code=abc"), "http://127.0.0.1:60944");
  assert.equal(getEmbedOrigin("https://telemetry.example.com/metrics"), "https://telemetry.example.com");
  assert.equal(getEmbedOrigin("/marketplace"), "/marketplace");
});

test("isLoopbackEmbedHost matches loopback hosts only", () => {
  assert.equal(isLoopbackEmbedHost("http://127.0.0.1:60944/"), true);
  assert.equal(isLoopbackEmbedHost("http://127.0.0.2:60944/"), true);
  assert.equal(isLoopbackEmbedHost("http://127.255.255.254/"), true);
  assert.equal(isLoopbackEmbedHost("http://localhost:3000/"), true);
  assert.equal(isLoopbackEmbedHost("http://[::1]:3000/"), true);
  assert.equal(isLoopbackEmbedHost("http://apps.example.com/"), false);
  assert.equal(isLoopbackEmbedHost("http://127x0.example.com/"), false);
  assert.equal(isLoopbackEmbedHost("not a url"), false);
});
