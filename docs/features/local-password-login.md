# Feature: Local Password Login

## Goal

Hosty Core should support normal local email/password login for installed and exposed deployments. After logout, local users must be able to sign in through Core `/login` without using CLI-generated recovery tokens.

## Non-goals

- External OIDC provider login.
- Trusted proxy provisioning changes.
- Password reset email delivery.
- Multi-factor authentication.
- Persistent distributed rate limiting across Core restarts.

## Current Behavior

First-administrator setup, administrator recovery, and local invitation acceptance require a password and create a Core browser session after a valid one-time token. In non-development mode, `/login` accepts local email/password credentials. In development mode, `/login` remains a local helper that lets developers select an enabled seeded user.

## Implemented Behavior

Core keeps the development login helper unchanged in `Development` environment.

In non-development mode, Core `/login` renders a local email/password form. Successful authentication creates the existing Core browser session cookie and redirects to Shell. Failed authentication returns a generic error that does not reveal whether the email, credential, or user state exists.

First-administrator setup, administrator recovery, and invitation acceptance require a password. The browser pages collect password and password confirmation, validate the confirmation client-side, and submit the password to Core. Core validates password policy server-side before creating or restoring the user.

Passwords must never be stored directly. Core stores local password credentials as records separate from `HostUserRecord`, using a per-password random salt and PBKDF2-HMAC-SHA256. New password credentials use 600,000 iterations, following current OWASP guidance for PBKDF2-HMAC-SHA256.

## User/API Scenarios

- A fresh installed Hosty user runs `hosty auth setup-token`, opens `/setup?setupToken=...`, enters email, display name, password, and confirmation, then becomes `host.admin`.
- The same administrator logs out, opens `/login`, enters email and password, and returns to Shell.
- An administrator generates an invitation for a `host.user` or `host.admin`. The recipient opens `/setup/invite?setupToken=...`, enters display name and password, and can later log in through `/login`.
- An administrator who has lost access can use `hosty auth recovery-token`, open `/recovery?recoveryToken=...`, set a replacement password, and get a new admin session.
- Development users created by `npm run dev` can still use the existing development selector without a password.

## Technical Design

Core adds a local password authentication service responsible for:

- password policy validation;
- credential hashing and verification;
- credential upsert for setup, recovery, and invitation acceptance;
- local email/password authentication;
- in-memory throttling for repeated failed login attempts.

Password credential records are stored in Core auth state separately from `HostUserRecord` entries, and APIs continue returning `HostUserRecord` and user summaries without password hash material.

Production `/login` is implemented in Core alongside the existing development login helper. Shell remains a browser client that redirects unauthenticated sessions to Core-owned `/login`.

## Data Model / API Changes

`UserDirectoryState` gains password credential records keyed by user id. Each credential stores:

- user id;
- algorithm id;
- iteration count;
- base64 salt;
- base64 hash;
- creation and update timestamps.

`AuthBootstrapRequest`, `AuthRecoveryRequest`, and `UserInvitationAcceptRequest` require `password` for successful account creation or recovery.

No app identity token format changes are required.

## Edge Cases

- Existing users without password credentials cannot use `/login` until a password is set through recovery or a future reset-password flow.
- Disabled users cannot authenticate even with a valid password.
- Login failures use a generic message to avoid account enumeration.
- Repeated failures are throttled in memory per email/IP key.
- Setup remains unavailable once an enabled administrator exists.
- Recovery remains the break-glass flow for local administrators.

## Testing Plan

- Unit tests for password credential creation and successful authentication.
- Unit tests for wrong password, disabled user, missing credential, and throttling.
- Bootstrap tests verifying setup requires password and stores only credential hash material.
- Recovery tests verifying recovery sets or replaces credentials and revokes old sessions.
- Invitation tests verifying accepted users receive password credentials.
- Regression tests for development login behavior remaining separate from production login.

## Rollout / Migration Notes

Existing installed users created before this feature do not have password credentials. Administrators should use `hosty auth recovery-token` once after upgrade to set a password. New users created after the feature must set a password during setup, recovery, or invitation acceptance.

The in-memory throttle resets when Core restarts. A future distributed deployment can move throttling state to durable storage.

## Open Questions

- Should invited ordinary users also set passwords?
  - Answer: Yes. Recommendation: require passwords for all local invited users so they can log in after logout.
- Should development `/login` switch to password login?
  - Answer: No. Recommendation: keep the seeded user selector for fast local development.
- Should Core create users directly from User Management without invitations?
  - Answer: No for this feature. Recommendation: keep invite-first local user creation.
- Should existing users be migrated automatically with generated passwords?
  - Answer: No. Recommendation: require explicit recovery or a future reset flow so no recoverable or temporary password is created.
