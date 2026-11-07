---
status: In Progress
created: 2026-11-07
updated: 2026-11-07
summary: Let administrators create local users with a password from a separate Shell dialog.
components: [apps/core, apps/shell]
---

# Direct User Creation

The operator approved direct user creation, with a separate button beside Invite User and a separate popup, in this conversation on 2026-11-07.

Extend the existing invitation-only management surface with Create User. Collect email, optional display name, password and confirmation, role, and initial app assignments. Core creates the account and password atomically using existing password policy, returns a safe summary, and preserves the administrator's session. Reject duplicate user emails and active invitations consistently with invitation creation. Apply existing administrator, app permission, CSRF, protected settings confirmation and audit rules.

## Deliverables

- [x] D1. Add protected POST /api/auth/users with atomic account, password and assignment creation and safe audit data.
- [x] D2. Add the adjacent Create User button and separate dialog with validation, inline errors, pending state and cleared credentials on close/success.
- [ ] D3. Verify service, HTTP authorization and dialog behavior, build affected components, run managed child Core checks, and update current feature documentation and component versions.

## Verification

The nine Create User component scenarios and 134 affected Core tests pass. One unrelated launched-app test cannot run on this Windows host because its sleep runtime exits before readiness. Native execution and configured Git authorship are restored. Refresh and integrate the current target before publication, then repeat checks affected by the merge.

- Exercise normal password authentication for a created account, assignments, administrator behavior, duplicate email/invitation conflicts and invalid input without partial writes.
- Verify anonymous/non-admin/missing app permission/CSRF refusals and protected settings confirmation.
- Exercise the rendered dialog, mismatch/error recovery, duplicate-submit prevention and cancellation reset.
- Run affected .NET tests, Shell checks and builds, docs index and version validation. Use a source child Core with separate test users/data for runtime API checks and report browser coverage accurately.
