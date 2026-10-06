import { afterEach, describe, expect, it, vi } from "vitest";
import { getRecoveryParams } from "@/lib/host-auth";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("getRecoveryParams", () => {
  it("prefers the browser-reachable Core origin over the server origin", async () => {
    vi.stubEnv("HOSTY_APP_ID", "hosty.telemetry");
    vi.stubEnv("HOSTY_CORE_ORIGIN", "http://hosty-core:7070");
    vi.stubEnv("HOSTY_CORE_PUBLIC_ORIGIN", "https://hosty.example.test");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ version: 2 })));
    expect(await getRecoveryParams()).toEqual({
      appId: "hosty.telemetry",
      corePublicOrigin: "https://hosty.example.test",
      appAuthProtocol: 2,
    });
  });

  it("reports a missing public origin as null — a broken environment, never a fallback", async () => {
    // Core always injects HOSTY_CORE_PUBLIC_ORIGIN, so an absent value means the environment
    // is broken; the old fallback produced a browser-useless container-internal URL.
    vi.stubEnv("HOSTY_APP_ID", "");
    vi.stubEnv("HOSTY_CORE_PUBLIC_ORIGIN", "");
    vi.stubEnv("HOSTY_CORE_ORIGIN", "http://hosty-core:7070");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ version: 2 })));
    expect(await getRecoveryParams()).toEqual({
      appId: "hosty.telemetry",
      corePublicOrigin: null,
      appAuthProtocol: 2,
    });
  });
});
