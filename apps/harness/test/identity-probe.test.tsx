// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { AppIdentityBridge } from "@hosty-sdk/app/react";
import { APP_GRANT_STORAGE_KEY, forgetAppGrant } from "@hosty-sdk/app/browser-auth";
import { createGatewayServer } from "../src/server";
import { SessionManager } from "../src/sessions/manager";
import { SessionStore } from "../src/sessions/store";
import { FakeHarnessAdapter } from "../src/harness/fake";
import { AuditReporter } from "../src/audit";

afterEach(() => {
  forgetAppGrant();
  sessionStorage.clear();
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

it.each([
  [401, "token_revoked", "expired", "signin"],
  [403, "token_app_mismatch", "forbidden", "denied"],
])("clears the stored grant through the real HTTP 200 %s probe carrying %s", async (status, code, sessionStatus, uiKind) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "self", "get").mockReturnValue({} as typeof window.self);
  vi.stubEnv("HOSTY_APP_ID", "hosty.harness");
  vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.test");
  vi.stubEnv("HOSTY_CORE_PUBLIC_ORIGIN", "http://core.localhost");
  vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service");
  const directory = await mkdtemp(path.join(os.tmpdir(), "harness-identity-probe-"));
  const adapter = new FakeHarnessAdapter();
  const manager = new SessionManager(new SessionStore(directory), adapter,
    new AuditReporter(null, null, "hosty.harness"), directory);
  const server = createGatewayServer(manager, adapter);
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  const nativeFetch = globalThis.fetch;
  let probeBody: unknown;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "http://core.test/api/auth/apps/revalidate") {
        return Response.json({ code, message: "Identity rejected." }, { status });
      }
      const response = await nativeFetch(new URL(String(input), origin), init);
      if (String(input) === "/api/auth/identity") {
        expect(response.status).toBe(200);
        probeBody = await response.clone().json();
      }
      return response;
    });
    sessionStorage.setItem(APP_GRANT_STORAGE_KEY, "hostyg_rejected");
    await act(async () => root.render(<AppIdentityBridge appCodePath="/api/app-code"
      renderState={state => <span>{state.kind}</span>} />));
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(node.textContent).toBe(uiKind);
    });
    expect(probeBody).toMatchObject({ status: sessionStatus, error: { code, status } });
    expect(sessionStorage.getItem(APP_GRANT_STORAGE_KEY)).toBeNull();
  } finally {
    await act(async () => root.unmount()); node.remove();
    await manager.shutdown();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
