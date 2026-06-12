# Auth Provider Extensions

Status: Idea.

## Context

Current Hosty authentication supports local setup, local recovery, local invitations, local password login, trusted-proxy session creation for an existing user, app-scoped authorization codes, app token exchange, and app session revalidation.

External-provider provisioning and password-reset delivery are intentionally not part of the current local password implementation.

## Ideas

- Add OIDC login that can provision or update external users through provider role mappings.
- Expand trusted-proxy assertions so they can provision or update external users through trusted proxy role mappings.
- Add password-reset invitations or another explicit reset flow for existing local users without password credentials.
- Add password reset email delivery when Hosty has an email delivery model.
- Move login throttling to durable storage if Hosty needs distributed deployments.

## Boundaries

- Provider-managed roles should remain read-only in User Management.
- External users should be created or updated when they authenticate through their provider, not pre-provisioned by local invitations.
- Do not create generated, recoverable, or temporary passwords for existing users.

