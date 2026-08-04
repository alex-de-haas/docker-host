import assert from "node:assert/strict";
import test from "node:test";
import { appendHostyLaunchParam } from "../src/app/shell/launch.ts";
import { appendHostyThemeParams } from "../src/app/shell/theme.ts";

test("appendHostyLaunchParam declares the embedded mode", () => {
  const url = new URL(appendHostyLaunchParam("http://127.0.0.1:60944/metrics"));
  assert.equal(url.searchParams.get("hosty_launch"), "embedded");
});

test("appendHostyLaunchParam preserves the app path and the theme params it rides beside", () => {
  const themed = appendHostyThemeParams("http://127.0.0.1:60944/logs?tail=1", "dark", "system");
  const url = new URL(appendHostyLaunchParam(themed));

  assert.equal(url.pathname, "/logs");
  assert.equal(url.searchParams.get("tail"), "1");
  assert.equal(url.searchParams.get("hosty_theme"), "dark");
  assert.equal(url.searchParams.get("hosty_theme_preference"), "system");
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
