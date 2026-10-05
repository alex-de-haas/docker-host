// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appCodeChallenge, createAppAuthAttempt, persistAppAuthAttempt, takeAppAuthAttempt, submitAppAuthIntent,
  appAuthNavigationUrl, acceptAppAuthProtocol, APP_AUTH_ATTEMPT_PREFIX, openAppSignIn, forgetAppGrant,
  rememberAppGrant, configureAppActivity, renewAppActivity, appFetch } from "./browser-auth";

let serial = 0;
let core: string;
let submitted: HTMLFormElement[];
const openUrl = () => `${core}/api/apps/sample/open?redirectUri=${encodeURIComponent(window.location.origin + "/draft")}`;
beforeEach(() => {
  core = `https://proof-${serial++}.test`;
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/draft");
  submitted = [];
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function(this: HTMLFormElement) { submitted.push(this); });
});
afterEach(() => { forgetAppGrant(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });

describe("private browser sign-in attempts", () => {
  it("implements the RFC S256 vector without Web Crypto digest", () => {
    expect(appCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
      .toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    expect(createAppAuthAttempt(openUrl(), "standalone", 2).codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("generates verifier and public state with separate CSPRNG calls", () => {
    const getRandomValues = vi.fn(crypto.getRandomValues.bind(crypto));
    vi.stubGlobal("crypto", { getRandomValues });
    const attempt = createAppAuthAttempt(openUrl(), "standalone", 2);
    expect(getRandomValues).toHaveBeenCalledTimes(2);
    expect(attempt.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attempt.state).toMatch(/^[a-f0-9]{64}$/);
    expect(appAuthNavigationUrl(attempt)).not.toContain(attempt.codeVerifier);
  });
  it("does not import attacker proof fields from a public authorization URL", () => {
    const url = new URL(openUrl()); url.searchParams.set("state", "attacker"); url.searchParams.set("codeChallenge", "a".repeat(43));
    url.searchParams.set("codeVerifier", "a".repeat(43));
    const attempt = createAppAuthAttempt(url.href, "silent", 2);
    expect(attempt.state).not.toBe("attacker"); expect(attempt.codeChallenge).not.toBe("a".repeat(43)); expect(attempt.codeVerifier).not.toBe("a".repeat(43));
  });
  it("fails closed when cryptographic randomness is unavailable", () => {
    vi.stubGlobal("crypto", {});
    expect(() => createAppAuthAttempt(openUrl(), "standalone", 2)).toThrow();
    expect(submitted).toHaveLength(0);
  });
  it("keeps concurrent local attempts independent and consumes only matching state", () => {
    const first = createAppAuthAttempt(openUrl(), "silent", 2), second = createAppAuthAttempt(openUrl(), "silent", 2);
    expect(persistAppAuthAttempt(first)).toBe(true); expect(persistAppAuthAttempt(second)).toBe(true);
    const invalid = new URL(first.redirectUri); invalid.searchParams.set("state", "e".repeat(64));
    expect(takeAppAuthAttempt(invalid)).toBeNull();
    const callback = new URL(first.redirectUri); callback.searchParams.set("code", "public-code");
    expect(takeAppAuthAttempt(callback)?.codeVerifier).toBe(first.codeVerifier);
    expect(takeAppAuthAttempt(callback)).toBeNull();
    expect(window.sessionStorage.getItem(`${APP_AUTH_ATTEMPT_PREFIX}${second.state}`)).not.toBeNull();
  });
  it.each(["expired", "different-page", "altered-state", "altered-proof"])("refuses a %s callback record", kind => {
    const attempt = createAppAuthAttempt(openUrl(), "standalone", 2);
    if (kind === "expired") attempt.createdAt -= 300_000;
    if (kind === "altered-state") attempt.state = "e".repeat(64);
    if (kind === "altered-proof") attempt.codeVerifier = "v".repeat(43);
    window.sessionStorage.setItem(`${APP_AUTH_ATTEMPT_PREFIX}${new URL(attempt.redirectUri).searchParams.get("state")}`, JSON.stringify(attempt));
    const callback = new URL(attempt.redirectUri); if (kind === "different-page") callback.pathname = "/other";
    expect(takeAppAuthAttempt(callback)).toBeNull();
  });
  it("refuses navigation proof when storage throws or loses its write", () => {
    const attempt = createAppAuthAttempt(openUrl(), "silent", 2);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(persistAppAuthAttempt(attempt)).toBe(false); expect(submitted).toHaveLength(0);
    vi.restoreAllMocks();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => undefined);
    expect(persistAppAuthAttempt(attempt)).toBe(false);
  });
  it("refuses the seventeenth live attempt without evicting another", () => {
    const attempts = Array.from({ length: 16 }, () => createAppAuthAttempt(openUrl(), "silent", 2));
    for (const attempt of attempts) expect(persistAppAuthAttempt(attempt)).toBe(true);
    expect(persistAppAuthAttempt(createAppAuthAttempt(openUrl(), "silent", 2))).toBe(false);
    expect(takeAppAuthAttempt(new URL(attempts[0].redirectUri))?.state).toBe(attempts[0].state);
  });
  it("does not accept a legacy record after observing protocol 2", () => {
    const attempt = createAppAuthAttempt(openUrl(), "standalone", 1);
    expect(persistAppAuthAttempt(attempt)).toBe(true);
    expect(acceptAppAuthProtocol(core, 2)).toBe(2);
    expect(takeAppAuthAttempt(new URL(attempt.redirectUri))).toBeNull();
    expect(() => createAppAuthAttempt(openUrl(), "standalone", 1)).toThrow("protocol");
  });
  it("renders an app-owned form with public fields and origin-only referrer policy", () => {
    const attempt = createAppAuthAttempt(openUrl(), "silent", 2);
    const doc = document.implementation.createHTMLDocument();
    submitAppAuthIntent(attempt, doc);
    const form = submitted[0];
    expect(form.method).toBe("post"); expect(form.action).toBe(`${core}/api/apps/sample/sign-in-intent`);
    expect(form.querySelector<HTMLInputElement>('input[name="prompt"]')?.value).toBe("none");
    expect(form.querySelector<HTMLInputElement>('input[name="codeChallenge"]')?.value).toBe(attempt.codeChallenge);
    expect(doc.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("origin");
    expect(doc.documentElement.outerHTML).not.toContain(attempt.codeVerifier);
    expect(doc.documentElement.outerHTML).not.toContain("<script");
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"))
      .toBe(`default-src 'none'; form-action ${core} 'self'; base-uri 'none'`);
  });
  it("puts only public proof fields and correlation state in native GET", () => {
    const attempt = createAppAuthAttempt(openUrl(), "native", 2);
    const url = new URL(appAuthNavigationUrl(attempt));
    expect(url.pathname).toBe("/api/apps/sample/open"); expect(url.searchParams.get("codeChallengeMethod")).toBe("S256");
    expect(new URL(url.searchParams.get("redirectUri")!).searchParams.get("state")).toBe(attempt.state);
    expect(url.href).not.toContain(attempt.codeVerifier);
  });
});

describe("protocol-2 app-owned popup", () => {
  it("does not reinstall identity when a renewal exchange finishes after logout", async () => {
    rememberAppGrant("old-grant");
    const popup = { document: document.implementation.createHTMLDocument(), close: vi.fn(), closed: false };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    let finish!: (body: { accessToken: string }) => void;
    const exchange = vi.fn(() => new Promise<{ accessToken: string }>(resolve => { finish = resolve; }));
    const cleanup = configureAppActivity({ openUrl: openUrl(), appAuthProtocol: 2, exchangeCode: exchange });
    const operation = renewAppActivity();
    const refused = expect(operation).rejects.toThrow("cancelled");
    const state = submitted[0].querySelector<HTMLInputElement>('input[name="state"]')!.value;
    window.dispatchEvent(new MessageEvent("message", { origin: core, source: popup as unknown as Window,
      data: { type: "hosty:app-auth-code", state, code: "public-code" } }));
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    forgetAppGrant(); finish({ accessToken: "late-grant" }); await refused;
    const fetcher = vi.fn().mockResolvedValue(Response.json({})); vi.stubGlobal("fetch", fetcher);
    await appFetch("/api/data", {}, false);
    expect(fetcher.mock.calls[0][1].headers.has("authorization")).toBe(false);
    cleanup();
  });
  it("opens synchronously and keeps proof in memory while posting a public intent", async () => {
    const popup = { document: document.implementation.createHTMLDocument(), close: vi.fn(), closed: false };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const operation = openAppSignIn(openUrl(), undefined, 2);
    expect(open).toHaveBeenCalledWith("about:blank", "_blank", expect.any(String)); expect(submitted).toHaveLength(1);
    const form = submitted[0]; const state = form.querySelector<HTMLInputElement>('input[name="state"]')!.value;
    expect([...Object.keys(window.sessionStorage)].some(key => key.startsWith(APP_AUTH_ATTEMPT_PREFIX))).toBe(false);
    window.dispatchEvent(new MessageEvent("message", { origin: core, source: popup as unknown as Window,
      data: { type: "hosty:app-auth-code", state, code: "public-code" } }));
    const result = await operation;
    expect(result.code).toBe("public-code"); expect(appCodeChallenge(result.codeVerifier)).toBe(form.querySelector<HTMLInputElement>('input[name="codeChallenge"]')!.value);
    expect(popup.document.documentElement.outerHTML).not.toContain(result.codeVerifier); expect(popup.close).toHaveBeenCalledOnce();
  });
  it("can sign in without storage but discards its proof on cancellation/logout", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const popup = { document: document.implementation.createHTMLDocument(), close: vi.fn(), closed: false };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const operation = openAppSignIn(openUrl(), undefined, 2);
    expect(submitted).toHaveLength(1);
    forgetAppGrant();
    await expect(operation).rejects.toThrow("cancelled"); expect(popup.close).toHaveBeenCalledOnce();
  });
});
