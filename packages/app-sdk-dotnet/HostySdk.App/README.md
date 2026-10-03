# HostySdk.App

Hosty app auth for .NET services — the NuGet counterpart of
[`@hosty-sdk/app`](https://www.npmjs.com/package/@hosty-sdk/app): Core identity revalidation
behind the platform's 30-second positive cache (negatives never cached), the `Hosty`
authentication scheme, and `HOSTY_*` options binding.

```csharp
var hosty = HostyAppOptions.FromConfiguration(builder.Configuration, "com.example.my-app");
builder.Services.AddHostyAppAuthentication(hosty, options =>
{
    options.IdentityCookieName = "my_app_hosty_identity";
    options.MapHostRole = role => role == "host.admin" ? "admin" : "user";
});
```

It also wraps the app's Core-managed secrets store — the keychain for runtime-acquired
credentials (OAuth tokens and the like) that an app must present to a third party, kept by
Core outside the app's backed-up data directory:

```csharp
builder.Services.AddHostySecrets(hosty);

// A missing secret is an expected state, not an error: it means "reconnect required".
var tokens = await secrets.GetAsync("trakt.connection.1.tokens", cancellationToken: ct);
await secrets.SetAsync("trakt.connection.1.tokens", refreshed, ct);
```

Reads are served from a write-through in-memory cache, so a briefly unavailable Core does not
break an app that already read its secret; pass `refresh: true` to force a live read.

Per the platform trust model, this package is for services exposing their own public
endpoints; private intra-app calls keep trusting the per-app network. The design contract
lives in the Hosty repository:
[`docs/features/hosty-app-sdk/feature.md`](https://github.com/alex-de-haas/docker-host/blob/main/docs/features/hosty-app-sdk/feature.md).

License: AGPL-3.0-only.

## Speech And Assistant Providers

Core 0.115.0 adds category permissions `providers.speech-to-text` and `providers.assistant`, declared
as required `corePermissions` or optional `optionalCorePermissions`. Each grant covers all confirmed
providers in that category. `HostyProviderClient.PermissionsAsync()` reads the app's actual grants.

```csharp
using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
{
    Timeout = TimeSpan.FromMinutes(5),
};
var client = new HostyProviderClient(http, HostyAppOptions.FromConfiguration(configuration, appId));
var providers = await client.ListAsync("speech-to-text", cancellationToken);
var selected = providers.Single(p => p.AppId == chosenAppId && p.Key == chosenKey);
var result = await client.TranscribeAsync(selected, wavBytes, cancellationToken: cancellationToken);
```

The baseline recording format is 16 kHz mono PCM16 WAV; inspect `SpeechCapabilitiesAsync()` for the
provider's limits/readiness. Clients capture audio themselves and keep recognized text editable.
`SendAssistantAsync()` supports the existing version-one `/handoffs` operations with an acting user's
app identity or delegated token. Provider-side `ValidateAsync()` checks live authority on every request.
Service credentials stay in the app backend and are sent only to Core. A provider credential conveys
no general administrator authority. See [Provider consumption](../../../docs/features/provider-consumption/feature.md).

## Assistant MCP credentials

Use `HostyScopedTokenClient.IntrospectMcpAsync` only in MCP handlers. It sends an explicit MCP
purpose to Core, supports scoped/OAuth and `hosty_mcp.1` assistant credentials, and returns the
current user, scopes and `CallerAppId`. Require `mcp:read` for reads or `mcp:invoke` for assistant
mutations and apply app user permissions. Never cache introspection. Ordinary APIs retain
`IntrospectAsync`, which rejects MCP-only credentials. Core checks the explicit assistant-target
relationship, installations and parent app session on every MCP validation.
