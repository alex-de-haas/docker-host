import assert from "node:assert/strict";
import test from "node:test";

import { loginContinuation } from "../src/app/shell/shell-routes.ts";

// A 401 sends the browser to Core's `/login`, and where it comes back decides whether a link into a
// particular Shell page survives the sign-in at all. The device authorization approval screen is the
// case that made this matter: an operator following an approval link with no session used to land on
// the dashboard, having lost the pending code they came to approve.
test("the page being left is offered back to Core as a relative continuation", () => {
  assert.equal(
    loginContinuation("/settings", "?tab=tokens"),
    `?returnTo=${encodeURIComponent("/settings?tab=tokens")}`);
  assert.equal(loginContinuation("/installed-apps", ""), `?returnTo=${encodeURIComponent("/installed-apps")}`);
});

// Core hardens the value again before acting on it, but an absolute or protocol-relative form must
// never be built here either — and the root is where an empty continuation already lands.
test("nothing that could be read as an origin is offered, and the root is not worth offering", () => {
  assert.equal(loginContinuation("/", ""), "");
  assert.equal(loginContinuation("//evil.example/settings", ""), "");
  assert.equal(loginContinuation("https://evil.example/settings", ""), "");
});

// The query is carried whole and encoded once, so a tab, a filter, or an app id survives a round trip
// through a redirect and a form field without becoming a second query string of Core's.
test("the continuation is encoded, so its own query cannot leak into Core's", () => {
  const continuation = loginContinuation("/settings", "?tab=tokens&app=com.haas.demo-app");

  assert.equal(continuation.indexOf("&"), -1);
  assert.equal(
    decodeURIComponent(continuation.slice("?returnTo=".length)),
    "/settings?tab=tokens&app=com.haas.demo-app");
});
