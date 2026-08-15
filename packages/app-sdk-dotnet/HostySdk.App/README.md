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
