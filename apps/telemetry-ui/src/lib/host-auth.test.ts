import { afterEach, describe, expect, it, vi } from "vitest";
import { getRecoveryParams } from "@/lib/host-auth";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getRecoveryParams", () => {
  it("prefers the browser-reachable Core origin over the server origin", () => {
    vi.stubEnv("HOSTY_APP_ID", "hosty.telemetry");
    vi.stubEnv("HOSTY_CORE_ORIGIN", "http://hosty-core:7070");
    vi.stubEnv("HOSTY_CORE_PUBLIC_ORIGIN", "https://hosty.example.test");

    expect(getRecoveryParams()).toEqual({
      appId: "hosty.telemetry",
      corePublicOrigin: "https://hosty.example.test",
    });
  });

  it("falls back to the server origin, then to the local default", () => {
    vi.stubEnv("HOSTY_APP_ID", "");
    vi.stubEnv("HOSTY_CORE_PUBLIC_ORIGIN", "");
    vi.stubEnv("HOSTY_CORE_ORIGIN", "http://hosty-core:7070");
    expect(getRecoveryParams()).toEqual({
      appId: "hosty.telemetry",
      corePublicOrigin: "http://hosty-core:7070",
    });

    vi.stubEnv("HOSTY_CORE_ORIGIN", "");
    expect(getRecoveryParams()).toEqual({
      appId: "hosty.telemetry",
      corePublicOrigin: "http://localhost:7070",
    });
  });
});
