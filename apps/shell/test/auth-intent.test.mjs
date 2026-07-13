import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_REQUIRED_INTENT_TYPE,
  parseActiveFrameAuthRequired,
} from "../src/app/shell/workspace/auth-intent.ts";

test("parseActiveFrameAuthRequired accepts a matching intent from the active frame and origin", () => {
  const activeFrame = {};
  const data = { type: AUTH_REQUIRED_INTENT_TYPE, appId: "com.haas.demo-app" };

  assert.equal(
    parseActiveFrameAuthRequired(
      { data, origin: "https://demo.example", source: activeFrame },
      activeFrame,
      "https://demo.example/app?code=secret",
      "com.haas.demo-app",
    ),
    true,
  );
});

test("parseActiveFrameAuthRequired rejects wrong sender, origin, app id, or shape", () => {
  const activeFrame = {};
  const data = { type: AUTH_REQUIRED_INTENT_TYPE, appId: "com.haas.demo-app" };
  const url = "https://demo.example/app";

  // Sender is not the active frame.
  assert.equal(
    parseActiveFrameAuthRequired({ data, origin: "https://demo.example", source: {} }, activeFrame, url, "com.haas.demo-app"),
    false,
  );
  // Origin does not match the frame URL.
  assert.equal(
    parseActiveFrameAuthRequired({ data, origin: "https://attacker.example", source: activeFrame }, activeFrame, url, "com.haas.demo-app"),
    false,
  );
  // Message app id does not match the mounted workspace app.
  assert.equal(
    parseActiveFrameAuthRequired({ data, origin: "https://demo.example", source: activeFrame }, activeFrame, url, "hosty.telemetry"),
    false,
  );
  // Wrong message type.
  assert.equal(
    parseActiveFrameAuthRequired(
      { data: { type: "hosty:other", appId: "com.haas.demo-app" }, origin: "https://demo.example", source: activeFrame },
      activeFrame,
      url,
      "com.haas.demo-app",
    ),
    false,
  );
  // Non-object payload.
  assert.equal(
    parseActiveFrameAuthRequired({ data: "nope", origin: "https://demo.example", source: activeFrame }, activeFrame, url, "com.haas.demo-app"),
    false,
  );
});
