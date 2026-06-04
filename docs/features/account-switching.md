# Browser Account Switching

Browser account switching was implemented in the retired Legacy Host auth stack. It is not part of the current Hosty Core/Shell implementation.

Current Core/Shell behavior uses one active Core session per browser context. Shell reads that session from `GET /api/auth/session`, uses it to filter app visibility, and redirects unauthenticated users to Core `/login`.

## Retired Legacy Behavior

The old implementation remembered multiple Host users in a server-side account set and selected one active Host session from the sidebar account menu. It used APIs such as:

- `GET /api/auth/accounts`;
- `POST /api/auth/accounts/switch`;
- `DELETE /api/auth/accounts/{userId}`;
- `DELETE /api/auth/accounts`.

Those endpoints and the old account-set cookie are not available in current Core/Shell builds.

## Future Direction

If account switching is restored, it should be implemented in Hosty Core against the current `core/auth/state.json` model and Shell sidebar. Future work must preserve these boundaries:

- account switching selects an existing Hosty user; it must not create hidden users or merge identities;
- switching creates a fresh Core session for the selected enabled user;
- app visibility and app identity tokens are recalculated from the new active user;
- Hosty session cookies must not be forwarded to app origins or gateway targets;
- audit events must not include raw cookies, bearer tokens, app tokens, or account-switching secrets.
