# OAuth Core Control Scopes

Created: 2026-09-08
Updated: 2026-09-08

OAuth consent can grant Core MCP lifecycle and update permissions in addition to read. The
[OAuth feature](../mcp-oauth/feature.md#resource-indicators-are-the-audience-rule) owns metadata,
consent and refresh semantics; [Core MCP](../core-mcp/feature.md#authorization) owns invocation
checks. [Credential management](../access-tokens/feature.md#management-surface) owns identification
and revocation. These are existing scoped permissions, not a full administrator credential.

## Testing Expectations

- Verify selectable consent and refresh scope subsets through the OAuth HTTP tests.
- Verify invocation acceptance/refusal through Core MCP tests and isolated clients against a
  Core-managed disposable environment. Remaining client validation is tracked in `plan.md`.
