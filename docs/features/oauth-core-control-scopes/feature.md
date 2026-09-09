# OAuth Core Control Scopes

Created: 2026-09-08
Updated: 2026-09-09

OAuth consent can grant Core MCP lifecycle and update permissions in addition to read. The
[OAuth feature](../mcp-oauth/feature.md#resource-indicators-are-the-audience-rule) owns metadata,
consent and refresh semantics; [Core MCP](../core-mcp/feature.md#authorization) owns invocation
checks. [Credential management](../access-tokens/feature.md#management-surface) owns identification
and revocation. These are existing scoped permissions, not a full administrator credential.

## Testing Expectations

- Verify selectable consent and refresh scope subsets through the OAuth HTTP tests.
- Verify invocation acceptance/refusal through Core MCP tests and isolated clients against a
  Core-managed disposable environment. The [stock Codex integration report](../../reviews/2026-09-09-codex-oauth-integration-validation.md)
  records read/expanded consent, proactive refresh across restarts, independent grants and revocation.
- Use isolated configuration and credential storage, verify the effective MCP inventory and constrain
  network access to the fixture. Preserve sanitized evidence and remove disposable credentials/data.
- Distinguish proactive refresh at the token deadline from recovery after unexpected server-only
  invalidation; the latter did not recover in the recorded Codex 0.147.0 run.
