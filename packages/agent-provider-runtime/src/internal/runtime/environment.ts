/** Forward only explicitly referenced per-run MCP bearers to native commands. */
export function nativeEnvironment(environment: NodeJS.ProcessEnv, args: string[]): NodeJS.ProcessEnv {
  const proxyVariables = new Set(args.flatMap(arg => {
    const match = /^mcp_servers\.[A-Za-z0-9_-]+\.bearer_token_env_var="(HOSTY_MCP_BEARER_[A-Z0-9_]+)"$/.exec(arg);
    return match ? [match[1]!] : [];
  }));
  return Object.fromEntries(Object.entries(environment).filter(([key]) =>
    (!key.startsWith("HOSTY_") || proxyVariables.has(key)) && !["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"].includes(key)));
}
