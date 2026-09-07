import assert from "node:assert/strict";
import test from "node:test";
import { appendHostyLaunchParam } from "../src/app/shell/launch.ts";
import { THEME_PARAM, THEME_PREFERENCE_PARAM } from "@hosty-sdk/app/theme";

test("appendHostyLaunchParam declares the embedded mode", () => {
  const url = new URL(appendHostyLaunchParam("http://127.0.0.1:60944/metrics"));
  assert.equal(url.searchParams.get("hosty_launch"), "embedded");
});

test("appendHostyLaunchParam preserves the app path and the theme params it rides beside", () => {
  // The theme parameters are named by the SDK, so they are read from it rather than spelled out
  // here: renaming one must move this test with it, not leave a literal that still passes while
  // Shell and the app have stopped agreeing. The URL is assembled from those same constants rather
  // than by `appendThemeLaunchParams`, because this suite runs on plain Node, which cannot resolve
  // the extensionless relative imports the `embedder` source uses (what the SDK's publish step
  // rewrites); the `theme` slice is self-contained and imports cleanly.
  const themed = new URL("http://127.0.0.1:60944/logs?tail=1");
  themed.searchParams.set(THEME_PARAM, "dark");
  themed.searchParams.set(THEME_PREFERENCE_PARAM, "system");
  const url = new URL(appendHostyLaunchParam(themed.toString()));

  assert.equal(url.pathname, "/logs");
  assert.equal(url.searchParams.get("tail"), "1");
  assert.equal(url.searchParams.get(THEME_PARAM), "dark");
  assert.equal(url.searchParams.get(THEME_PREFERENCE_PARAM), "system");
  assert.equal(url.searchParams.get("hosty_launch"), "embedded");
});

// A workspace URL is re-derived on a reissue, and re-appending must not stack duplicates that
// would reach the app as a repeated parameter.
test("appendHostyLaunchParam is idempotent", () => {
  const once = appendHostyLaunchParam("http://127.0.0.1:60944/");
  const twice = appendHostyLaunchParam(once);

  assert.equal(twice, once);
  assert.deepEqual(new URL(twice).searchParams.getAll("hosty_launch"), ["embedded"]);
});
