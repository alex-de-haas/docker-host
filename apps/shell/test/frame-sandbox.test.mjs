import assert from "node:assert/strict";
import test from "node:test";
import { appFrameSandbox } from "../src/app/shell/embedding/frame-sandbox.ts";

test("ordinary apps retain sandboxed popups, including missing and unrelated grants", () => {
  for (const grants of [undefined, null, [], ["apps.read"], ["apps.install.other"], ["APPS.INSTALL"]]) {
    const flags = appFrameSandbox(grants).split(" ");
    assert.ok(flags.includes("allow-popups"));
    assert.ok(!flags.includes("allow-popups-to-escape-sandbox"));
    assert.ok(!flags.includes("allow-top-navigation"));
  }
});

test("either approved installation permission enables Core confirmation without changing other flags", () => {
  const baseline = appFrameSandbox().split(" ");
  for (const grants of [["apps.install"], ["apps.update"], ["apps.install", "apps.update"]]) {
    const flags = appFrameSandbox(grants).split(" ");
    assert.deepEqual(flags.filter((flag) => flag !== "allow-popups-to-escape-sandbox"), baseline);
    assert.ok(flags.includes("allow-popups-to-escape-sandbox"));
  }
});
