import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTALL_FEED_INTENT_TYPE,
  INSTALL_FEED_INTENT_VERSION,
  MARKETPLACE_APP_ID,
  appMayRequestFeedInstall,
  parseActiveFrameInstallFeedIntent,
  parseInstallFeedIntent,
} from "../src/app/shell/workspace/install-intent.ts";

test("appMayRequestFeedInstall admits only the Marketplace app id", () => {
  assert.equal(appMayRequestFeedInstall(MARKETPLACE_APP_ID), true);
  assert.equal(appMayRequestFeedInstall("hosty.marketplace"), true);
  assert.equal(appMayRequestFeedInstall("com.example.app"), false);
  assert.equal(appMayRequestFeedInstall("hosty.telemetry"), false);
  assert.equal(appMayRequestFeedInstall("hosty.shell"), false);
  assert.equal(appMayRequestFeedInstall(""), false);
});

test("parseInstallFeedIntent accepts the versioned http(s) contract", () => {
  assert.deepEqual(
    parseInstallFeedIntent({
      type: INSTALL_FEED_INTENT_TYPE,
      version: INSTALL_FEED_INTENT_VERSION,
      feedsUrl: " https://apps.example/feeds.json ",
      feedId: " stable ",
    }),
    { feedsUrl: "https://apps.example/feeds.json", feedId: "stable" },
  );
  assert.deepEqual(
    parseInstallFeedIntent({
      type: INSTALL_FEED_INTENT_TYPE,
      version: INSTALL_FEED_INTENT_VERSION,
      feedsUrl: "http://localhost:8080/feeds.json",
    }),
    { feedsUrl: "http://localhost:8080/feeds.json", feedId: null },
  );
});

test("parseInstallFeedIntent rejects unknown contracts and unsafe URLs", () => {
  for (const value of [
    null,
    {},
    { type: INSTALL_FEED_INTENT_TYPE, version: 2, feedsUrl: "https://apps.example/feeds.json" },
    { type: INSTALL_FEED_INTENT_TYPE, version: 1, feedsUrl: "file:///tmp/feeds.json" },
    { type: INSTALL_FEED_INTENT_TYPE, version: 1, feedsUrl: "https://user:secret@apps.example/feeds.json" },
    { type: INSTALL_FEED_INTENT_TYPE, version: 1, feedsUrl: "https://apps.example/feeds.json", feedId: "" },
    { type: INSTALL_FEED_INTENT_TYPE, version: 1, feedsUrl: "https://apps.example/feeds.json", feedId: null },
  ]) {
    assert.equal(parseInstallFeedIntent(value), null);
  }
});

test("parseInstallFeedIntent bounds values before forwarding them", () => {
  assert.equal(
    parseInstallFeedIntent({
      type: INSTALL_FEED_INTENT_TYPE,
      version: 1,
      feedsUrl: `https://apps.example/${"a".repeat(4096)}`,
    }),
    null,
  );
  assert.equal(
    parseInstallFeedIntent({
      type: INSTALL_FEED_INTENT_TYPE,
      version: 1,
      feedsUrl: "https://apps.example/feeds.json",
      feedId: "a".repeat(129),
    }),
    null,
  );
});

test("parseActiveFrameInstallFeedIntent binds the intent to the active iframe and its exact origin", () => {
  const activeFrame = {};
  const data = {
    type: INSTALL_FEED_INTENT_TYPE,
    version: INSTALL_FEED_INTENT_VERSION,
    feedsUrl: "https://apps.example/feeds.json",
  };

  assert.deepEqual(
    parseActiveFrameInstallFeedIntent(
      { data, origin: "https://marketplace.example", source: activeFrame },
      activeFrame,
      "https://marketplace.example/store?code=secret",
    ),
    { feedsUrl: "https://apps.example/feeds.json", feedId: null },
  );
  assert.equal(
    parseActiveFrameInstallFeedIntent(
      { data, origin: "https://attacker.example", source: activeFrame },
      activeFrame,
      "https://marketplace.example/store",
    ),
    null,
  );
  assert.equal(
    parseActiveFrameInstallFeedIntent(
      { data, origin: "https://marketplace.example", source: {} },
      activeFrame,
      "https://marketplace.example/store",
    ),
    null,
  );
});
