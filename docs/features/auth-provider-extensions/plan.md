---
status: Draft
created: 2026-06-12
updated: 2026-10-05
summary: External identity providers, password reset and durable login throttling beyond local password login.
components: [apps/core, apps/shell]
---

# Auth Provider Extensions

Hosty authentication today is local: setup, recovery, invitations and email/password login
([local password login](../local-password-login/feature.md)), trusted-proxy session creation for an
existing user, and the app authorization code flow ([auth and gateway model](../auth-gateway/feature.md)).
External-provider provisioning and password-reset delivery are deliberately absent. Carried over from
`docs/ideas/` on 2026-10-05.

App-provided additional login methods (`hosty.auth.method@1`, linking an external identity to an
existing local user) belong to the [core extension model](../core-extension-model/plan.md) and are not
repeated here.

## Target Behavior

- OIDC login can provision or update external users through provider role mappings.
- Trusted-proxy assertions can provision or update external users through trusted-proxy role
  mappings.
- Existing local users without a password credential can reset through an explicit flow, such as a
  password-reset invitation; email delivery follows once Hosty has an email delivery model.
- Login throttling can move to durable storage if Hosty ever needs distributed deployments.

Boundaries:

- Provider-managed roles stay read-only in [user management](../user-management/feature.md); external
  users are listed, disabled and assigned to apps on the same page.
- External users are created or updated when they authenticate through their provider, never
  pre-provisioned by local invitations.
- Hosty never creates generated, recoverable or temporary passwords for existing users.

## Deliverables

- [ ] D1. OIDC login with provisioning and role mappings.
- [ ] D2. Trusted-proxy provisioning with role mappings.
- [ ] D3. Password reset for existing local users without a password credential.
- [ ] D4. Password-reset email delivery, once an email delivery model exists.
- [ ] D5. Durable login throttling, if distributed deployments become a requirement.

## Open Questions

1. Which of these does the owner want first, if any?
2. Which OIDC providers must be supported, and how are role mappings configured?

## Verification

- Each provider path is exercised through Core's real login pipeline with an isolated data root,
  including refusal of provider-managed role edits in user management.
