import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const styles = readFileSync("../core/src/Haas.Hosty.Core/Browser/account.css", "utf8");
const source = readFileSync("../core/src/Haas.Hosty.Core/Browser/account.js", "utf8");
let request: ReturnType<typeof vi.fn>;
const profile = { email: "alice@example.test", displayName: '<img src=x onerror="alert(1)">', connections: [], providers: {} };
beforeEach(() => {
  document.body.innerHTML = '<h1>Your account</h1><p id="error" hidden></p><p id="notice" hidden></p><div id="content"></div>';
  const style = document.createElement("style"); style.textContent = styles; document.body.append(style);
  history.replaceState(null, "", "/account/tokens");
  request = vi.fn(async (path: string) => Response.json(path === "/api/auth/csrf" ? { token: "csrf" } : profile));
  vi.stubGlobal("fetch", request);
});
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });
const start = () => { new Function(source)(); };
it("renders only token creation without credential or client listings", async () => {
  request.mockImplementation(async path => Response.json(path === "/api/auth/session" ? { user: { role: "host.user" } } : { apps: [] }));
  start(); await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull());
  expect(document.body.textContent).toContain("Create an access token");
  expect(request.mock.calls.map(call => call[0])).toEqual(["/api/auth/session", "/api/apps"]);
  expect(document.body.textContent).not.toContain("Registered OAuth clients");
});
