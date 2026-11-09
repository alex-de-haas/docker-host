import { expect, it } from "vitest";
import { nativeEnvironment } from "./native.js";
it("passes only the session MCP bearer named by the command while isolating Worker authority", () => {
  const env = nativeEnvironment({ PATH: "/usr/bin", HOME: "/control", CODEX_HOME: "/control/account", HOSTY_APP_SERVICE_TOKEN: "private-service", HOSTY_WORKER_TOKEN: "private-worker", HOSTY_MCP_BEARER_UNRELATED: "unrelated", HOSTY_MCP_BEARER_SESSION: "session-only" },
    ["app-server", "-c", 'mcp_servers.hosty-workspaces.bearer_token_env_var="HOSTY_MCP_BEARER_SESSION"']);
  expect(env).toEqual({ PATH: "/usr/bin", HOSTY_MCP_BEARER_SESSION: "session-only" });
  expect(nativeEnvironment({ HOSTY_APP_SERVICE_TOKEN: "private" }, ['mcp_servers.evil.bearer_token_env_var="HOSTY_APP_SERVICE_TOKEN"'])).toEqual({});
});
