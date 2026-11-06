# SDK And App Creation

Read the running Core guide's `sdk` and `identity` topics for its current contract. Core, the npm
`@hosty-sdk/app` package and NuGet `HostySdk.App` version independently; inspect the installed
package exports rather than assuming feature parity or matching version numbers.

## Choose The Integration For The Stack

- TypeScript/React: the browser bridge, authenticated browser fetch and embedding helpers manage
  app-origin identity and UI integration. The `/server` entry point targets Next/React server code;
  a plain Node backend must not import it. Use the starter's direct HTTP exchange/revalidation
  pattern and pure helpers for other Node frameworks.
- .NET: `AddHostyAppAuthentication` supplies backend authentication; apply the app's authorization
  policies and middleware separately. The package has scoped-token, provider and secret clients,
  but no equivalent browser login bridge. Pair it with a supported frontend or implement the
  documented browser protocol.
- Other languages: the platform's HTTP contracts are the integration boundary. Implement the
  versioned identity protocol rather than inventing an SDK or assuming a header is trusted.

## Separate Identities And Responsibilities

Core injects server-side app identity and its own origin into managed launches. Keep service
credentials on the backend. Browser sign-in establishes the application's own opaque grant through
Core's normal login and code exchange. Validate/revalidate that grant for protected requests and
apply app-specific authorization; identity alone is not permission for every operation.

An app service token, browser app grant and scoped MCP credential have different audiences and
purposes. Use the MCP-specific introspection path only for MCP handlers. Do not accept that
credential as a normal browser/API session, expose service credentials in a frontend bundle or
invent a default administrator/password for testing.

## Development Flow

Choose the supported creation/workspace operation, then adapt the starter or existing app in its
registered worktree. Declare runtime services, storage and dependencies in the manifest. Keep
source and application data separate. Build/test locally in that workspace, then use a managed
child Core for actual identity, app assignment, permissions and standalone/embedded browser checks.

Use the guide's `source` and `docker` topics for workspace/runtime details, `preview` for lifecycle,
and `checks`/`finish` for verification and cleanup. Repository planning and commit rules still apply;
choosing this skill does not authorize a commit, deployment, source switch or live-data trial.
