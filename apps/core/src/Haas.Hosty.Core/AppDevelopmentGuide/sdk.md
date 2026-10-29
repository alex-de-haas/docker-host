# SDK capabilities by stack

Use published packages and inspect their installed exports. Core, npm @hosty-sdk/app and NuGet
HostySdk.App version independently; a Core version does not imply identical SDK capabilities.
This guide describes the packages available with this Core source, not hypothetical API parity.

| Capability | TypeScript @hosty-sdk/app | .NET HostySdk.App | Other languages |
| --- | --- | --- | --- |
| Browser login and recovery | AppIdentityBridge from /react, appFetch from /browser-auth, /app-code proof helpers | No browser bridge or code exchange; pair with a TS UI or implement the identity topic | Implement browser initiation, PKCE/callback correlation and server exchange |
| Backend app identity | /server has the Next validator; /session/server formats an already validated session | AddHostyAppAuthentication, Hosty authentication scheme, Core revalidation | POST token/revalidate with own app service credential |
| Scoped/MCP credentials | /scoped-token, /oauth-resource | HostyScopedTokenClient; IntrospectMcpAsync only for MCP handlers | Use the documented purpose-bound introspection protocol, not ordinary app revalidation |
| Provider consumption | /providers and /providers/server | HostyProviderClient | Explicitly implement provider discovery/credential contract |
| App-owned secrets | /server has Next secret helpers; no general browser secret access | AddHostySecrets and server secret client | Authenticated Core app-secret API from the backend only |
| Child Core/sandbox coordinator | /sandbox/server and /sandbox/react | No equivalent environment coordinator in this package | Use reviewed typed Core APIs; no broad host CLI bridge |
| Browser embedding/UI integration | /embedder, /ui, /ui/react, /theme, /continuity/browser | No browser UI adapters | Implement browser contract or reuse a TS frontend |

Plain Node must not import /server: it imports `server-only` and assumes a Next/React server.
The packaged Node bootstrap's auth.ts shows direct HTTP exchange/revalidation with the pure
/app-code and /continuity helpers; preserve its recovery behavior when replacing the framework.
.NET can register authentication as follows (application authorization still applies):

```csharp
var hosty = HostyAppOptions.FromConfiguration(builder.Configuration, "com.example.notes");
builder.Services.AddHostyAppAuthentication(hosty, options =>
{
    options.IdentityCookieName = "notes_hosty_identity";
    options.MapHostRole = role => role == "host.admin" ? "admin" : "user";
});
// Add the app's authorization policies and authentication/authorization middleware as usual.
```

Rust, Python and other stacks do not require an unofficial SDK. Implement the exact requests in
`identity`, using server-only injected credentials, bounded HTTP timeouts and redirects disabled.
Keep browser and server responsibilities separate. A local server or health response is not a
substitute for testing real Hosty login in standalone and embedded views.

CoreEnvironmentClient remains available from @hosty-sdk/app/sandbox/server for environment
coordinators. The single-app SandboxClient and readSandboxIdentity/readSandboxTarget exports are
removed. Applications use ordinary Core session and directory contracts, with app-owned roles;
no runtime-specific identity branch or HOSTY_SANDBOX_* variables are needed.
