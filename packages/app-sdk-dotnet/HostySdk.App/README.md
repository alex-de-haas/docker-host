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

Per the platform trust model, this package is for services exposing their own public
endpoints; private intra-app calls keep trusting the per-app network. The design contract
lives in the Hosty repository:
[`docs/ideas/hosty-app-sdk.md`](https://github.com/alex-de-haas/docker-host/blob/main/docs/ideas/hosty-app-sdk.md).

License: AGPL-3.0-only.
