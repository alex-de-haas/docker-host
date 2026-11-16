import { expect, it } from "vitest";
import { nativeEnvironment } from "../runtime/environment.js";
it("passes only explicitly selected run bearers while preserving application-supplied native configuration", () => {
  const env = nativeEnvironment({ PATH: "/usr/bin", HOME: "/selected", ENGINE_CONFIG_HOME: "/account", HOSTY_APP_SERVICE_TOKEN: "private-service", HOSTY_WORKER_TOKEN: "private-worker", HOSTY_MCP_BEARER_UNRELATED: "unrelated", HOSTY_MCP_BEARER_SESSION: "session-only" }, ["HOSTY_MCP_BEARER_SESSION"]);
  expect(env).toEqual({ PATH: "/usr/bin", HOME: "/selected", ENGINE_CONFIG_HOME: "/account", HOSTY_MCP_BEARER_SESSION: "session-only" });
  expect(nativeEnvironment({ HOSTY_APP_SERVICE_TOKEN: "private" }, ["HOSTY_APP_SERVICE_TOKEN"])).toEqual({});
});
