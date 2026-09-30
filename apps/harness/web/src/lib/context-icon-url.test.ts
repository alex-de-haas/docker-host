import { expect, it } from "vitest";
import { contextIconUrl } from "./context-icon-url";
const asset = "/api/apps/media/assets/assets/icon.svg?v=3";
it.each([
  ["http://localhost:7070", "127.0.0.1", "http://127.0.0.1:7070"],
  ["https://127.0.0.1:7443", "localhost", "https://localhost:7443"],
  ["http://localhost:7070", "[::1]", "http://[::1]:7070"],
])("uses the page's local alias for authenticated Core assets: %s", (origin, hostname, expected) => {
  expect(contextIconUrl(origin + asset, "media", hostname)).toBe(expected + asset);
});
it("does not rewrite remote, external, other-app or non-asset destinations", () => {
  for (const value of ["https://core.example.test" + asset, "http://localhost:7070/logo.png", "http://localhost:7070/api/apps/other/assets/icon.svg"])
    expect(contextIconUrl(value, "media", "127.0.0.1")).toBe(value);
  expect(contextIconUrl("http://localhost:7070" + asset, "media", "shell.example.test")).toBe("http://localhost:7070" + asset);
  expect(contextIconUrl("http://localhost:7070" + asset, "media")).toBe("http://localhost:7070" + asset);
});
it("rejects malformed URLs, non-web schemes and embedded credentials", () => {
  for (const value of [undefined, "", "bad url", "javascript:alert(1)", "data:image/svg+xml,test", "https://secret@localhost:7070" + asset])
    expect(contextIconUrl(value, "media", "127.0.0.1")).toBeUndefined();
});
