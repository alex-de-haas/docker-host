/** Forward only explicitly selected per-run MCP bearers; argument syntax belongs to the adapter. */
export function nativeEnvironment(environment: NodeJS.ProcessEnv, bearerVariables: readonly string[] = []): NodeJS.ProcessEnv {
  const allowed = new Set(bearerVariables.filter(key => /^HOSTY_MCP_BEARER_[A-Z0-9_]+$/.test(key)));
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith("HOSTY_") || allowed.has(key)));
}
