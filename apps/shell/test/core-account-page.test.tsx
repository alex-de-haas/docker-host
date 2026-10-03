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
it("groups same-name OAuth clients by exact ID and hides admin-only rename from regular users", async () => {
  history.replaceState(null, "", "/account/tokens");
  request.mockImplementation(async path => Response.json(path === "/api/auth/session" ? { user: { role: "host.user" } }
    : path === "/api/auth/credentials" ? { credentials: ["first", "second"].map((client, index) => ({ id: `fingerprint-${index}`, kind: "oauth", label: "Grant", userId: "u", userDisplayName: "Alice", oauthClientId: client, oauthClientName: "Same name", createdAt: "2026-10-01T00:00:00Z", lastSeenAt: "2026-10-01T00:00:00Z" })) }
    : path === "/api/apps" ? { apps: [] } : { requests: [] }));
  start(); await vi.waitFor(() => expect(document.querySelectorAll("h3")).toHaveLength(2));
  expect([...document.querySelectorAll("h3")].map(node => node.textContent)).toEqual(["Same name · first", "Same name · second"]);
  expect(document.body.textContent).toContain("fingerprint-0");
  expect([...document.querySelectorAll("button")].some(node => node.textContent === "Rename")).toBe(false);
});
