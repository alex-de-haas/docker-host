using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Microsoft.AspNetCore.Cors.Infrastructure;
using Microsoft.AspNetCore.HttpOverrides;

namespace Haas.Hosty.Core;

internal static class HostyCoreApplication
{
    private const string ControlSecretHeader = "X-Hosty-Control-Secret";

    // `config` defaults to the process environment — what the real entry point wants — and is passed
    // explicitly by hosts that cannot use ambient state: the process environment is one shared mutable
    // variable, so a test that sets HOSTY_CORE_* to exercise config parsing poisons every other host
    // booting in the same process at that instant, and several such hosts need their own data root
    // simultaneously anyway, which env cannot express per-instance. This is the only env read in the
    // startup path, so passing a config keeps the boot entirely off the environment.
    public static void ConfigureServices(WebApplicationBuilder builder, HostyCoreRuntimeConfig? config = null)
    {
        config ??= HostyCoreRuntimeConfig.FromEnvironment(builder.Environment);
        builder.WebHost.UseUrls(config.ListenUrl);
        builder.Services.ConfigureHttpJsonOptions(options =>
            options.SerializerOptions.TypeInfoResolverChain.Insert(0, CoreJsonSerializerContext.Default));
        builder.Services.AddSingleton(config);
        builder.Services.AddSingleton<CoreSettingsStore>();
        builder.Services.AddSingleton<CoreSettingsService>();
        // AuthLifetimes resolves live from the settings service (edited from the Shell platform panel),
        // so a TTL change applies without a restart: idle windows immediately, absolute windows for
        // grants/sessions issued afterward. Transient so each per-request injection re-reads the current
        // value rather than capturing a startup snapshot.
        builder.Services.AddTransient(sp => sp.GetRequiredService<CoreSettingsService>().AuthLifetimes);
        builder.Services.AddSingleton(sp => CoreDataPaths.FromConfig(sp.GetRequiredService<HostyCoreRuntimeConfig>()));
        // Two secrets, deliberately split: the ControlSecret guards the CLI control endpoints and is
        // per-process (the discovery file carrying it is rewritten each boot), while the app service
        // token key is durable on disk — a keep-apps restart adopts still-running containers whose
        // HOSTY_APP_SERVICE_TOKEN was baked in by the previous Core, so it must keep validating here.
        builder.Services.AddSingleton(new ControlSecret(CreateControlSecret()));
        builder.Services.AddSingleton(sp => AppServiceSigningKey.LoadOrCreate(sp.GetRequiredService<CoreDataPaths>()));
        builder.Services.AddSingleton<AppServiceTokenService>();
        // Durable like the app service key (its public half is baked into app environments and must
        // survive keep-apps restarts), but asymmetric: apps validate delegated tokens locally.
        builder.Services.AddSingleton(sp => DelegatedTokenSigningKey.LoadOrCreate(sp.GetRequiredService<CoreDataPaths>()));
        builder.Services.AddSingleton<DelegatedTokenService>();
        builder.Services.AddSingleton<AppRegistryStore>();
        builder.Services.AddSingleton<AppSecretsStore>();
        builder.Services.AddSingleton<ShellPublicOriginResolver>();
        builder.Services.AddSingleton<MountPathPolicy>();
        builder.Services.AddSingleton<GlobalMountStore>();
        builder.Services.AddSingleton<GlobalMountService>();
        builder.Services.AddSingleton<UserDirectoryStore>();
        builder.Services.AddSingleton<AuthBootstrapTokenStore>();
        builder.Services.AddSingleton<AuditStore>();
        builder.Services.AddSingleton<AppAuthCodeStore>();
        builder.Services.AddSingleton<DeviceAuthorizationStore>();
        builder.Services.AddSingleton<AppSessionGrantStore>();
        builder.Services.AddSingleton<AppIdentityService>();
        builder.Services.AddSingleton<LocalPasswordAuthService>();
        builder.Services.AddSingleton<AuthBootstrapService>();
        builder.Services.AddSingleton<UserManagementService>();
        builder.Services.AddSingleton(sp => new AppManifestService(AppManifestService.CreateDefaultHttpClient()));
        // The feed document is untrusted lifecycle input fetched over http(s). Refuse auto-redirects
        // so a feed URL cannot bounce Core onto an internal host (SSRF); a 3xx surfaces as a non-success
        // status and fails the load. AppFeedService also rejects non-http(s)/credentialed URLs.
        builder.Services.AddHttpClient<AppFeedService>(client => client.Timeout = TimeSpan.FromSeconds(20))
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false });
        builder.Services.AddSingleton<AppBackupService>();
        builder.Services.AddSingleton<NotificationStore>();
        builder.Services.AddSingleton<CoreEventHub>();
        builder.Services.AddSingleton<NotificationService>();
        builder.Services.AddSingleton<AppSourceService>();
        // Shared flag the control-plane stop endpoint sets and the runtime-app supervisor reads at
        // shutdown to decide whether a stop leaves app containers running (keep-apps light restart).
        builder.Services.AddSingleton<CoreShutdownOptions>();
        // Fast Core update-available check for the Shell sidebar. Its own named HttpClient follows
        // redirects (release downloads bounce github.com -> the object CDN), unlike the SSRF-guarded feed
        // client. Singleton so its TTL cache survives across requests.
        builder.Services.AddHttpClient(CoreUpdateCheckService.HttpClientName, client => client.Timeout = TimeSpan.FromSeconds(20));
        builder.Services.AddSingleton<CoreUpdateCheckService>();
        // One-click Cloudflare ingress (phase 1): a named client for the Cloudflare API, the read-only
        // discovery client, and the private token store.
        builder.Services.AddHttpClient(CloudflareApiClient.HttpClientName, client => client.Timeout = TimeSpan.FromSeconds(20));
        builder.Services.AddSingleton<ICloudflareApiClient, CloudflareApiClient>();
        builder.Services.AddSingleton<CloudflareCredentialStore>();
        builder.Services.AddSingleton<CloudflareIntegrationStore>();
        builder.Services.AddSingleton<CloudflarePublicationStore>();
        builder.Services.AddSingleton<CloudflarePublicationReconciler>();
        builder.Services.AddSingleton<CloudflarePublicationService>();
        builder.Services.AddSingleton<CloudflareConnectionService>();
        builder.Services.AddSingleton<CloudflareDiagnosticsService>();
        // Decides which HOSTY_PUBLIC_ORIGIN_* values the active ingress provider owns; the `configure`
        // guard reads it, so it must be registered for that guard to exist at all.
        builder.Services.AddSingleton<PublicOriginOwnership>();
        builder.Services.AddSingleton<RuntimePortAllocator>();
        builder.Services.AddSingleton<CoreLifecycleService>();
        builder.Services.AddSingleton<LocalCommandProcessRegistry>();
        // Resolve the setsid shim path once so the localCommand adapter spawns reclaimable process-group
        // leaders. Null (Windows / dll-hosted run) makes the adapter fall back to a direct /bin/sh spawn.
        builder.Services.AddSingleton(new LocalCommandShimOptions(LocalCommandShim.ResolveShimPath()));
        builder.Services.AddSingleton<IHealthProbe, NetworkHealthProbe>();
        // Shared docker CLI runner so the runtime adapter and the telemetry scrape loop go through one
        // instance; the adapter's optional ctor param picks this up via DI in production.
        builder.Services.AddSingleton<IDockerCommandRunner, ProcessDockerCommandRunner>();
        // Fast path for the reviewed-update plan's registry digest lookups: a direct registry HTTP
        // probe, roughly 7x quicker than the `docker buildx imagetools inspect` it fronts. Redirects
        // are not followed — a manifest probe must not be bounced to an unvetted host — and anything
        // it cannot answer falls back to the docker CLI inside the adapter. Singleton so its anonymous
        // token cache survives across checks.
        builder.Services.AddHttpClient(RegistryDigestResolver.HttpClientName, client => client.Timeout = TimeSpan.FromSeconds(20))
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false });
        builder.Services.AddSingleton<IRegistryDigestResolver, RegistryDigestResolver>();
        builder.Services.AddSingleton<IAppRuntimeAdapter, DockerRuntimeAdapter>();
        builder.Services.AddSingleton<IAppRuntimeAdapter, LocalCommandRuntimeAdapter>();
        builder.Services.AddSingleton<IClock, SystemClock>();
        // Observability Phase 2: the telemetry store, query API, and observability UI all live in the
        // telemetry system app. Core keeps only the producer role it cannot shed — re-exposing
        // host-collected `docker stats` as Prometheus for the backend to scrape. The telemetry read path
        // no longer runs through Core; the telemetry UI reads its backend directly. Registered as a
        // singleton the exposition endpoint reads and run as a hosted service.
        builder.Services.AddSingleton<DockerStatsExposition>();
        builder.Services.AddHostedService(sp => sp.GetRequiredService<DockerStatsExposition>());
        // One controller: it reads the live ingress provider from CoreSettingsService and no-ops for every
        // provider that is not "cloudflared", so switching providers is a settings edit, not a restart.
        builder.Services.AddSingleton<IIngressController, CloudflaredIngressController>();
        // Generic bootstrap: the release-owned distribution list and the operator's bootstrap
        // choices drive which first-party apps the supervisor preinstalls at boot; the service is
        // shared with the host-admin bootstrap endpoints for live toggles.
        builder.Services.AddSingleton<DistributionAppsProvider>();
        builder.Services.AddSingleton<DistributionSeedStore>();
        builder.Services.AddSingleton<SystemAppBootstrapService>();
        // Runs before the schedulers below so an upgraded installation's existing state/backups/logs
        // are tightened before anything starts appending to them.
        builder.Services.AddHostedService<CoreFilePermissionMigration>();
        // Selects the API ingress provider on a host that connected Cloudflare before it was one. Runs
        // before the supervisor so the first app start of this boot already sees the right provider.
        builder.Services.AddHostedService<CloudflareProviderMigration>();
        builder.Services.AddHostedService<RuntimeAppSupervisorService>();
        builder.Services.AddHostedService<AppBackupRetentionScheduler>();
        builder.Services.AddHostedService<NotificationRetentionScheduler>();
        builder.Services.AddHostedService<UserRetentionScheduler>();
        // Plan-first updates: the fleet sweep is a singleton (the trigger endpoint and the apps-list
        // status block read it) and its scheduler runs it on the Core-settings cadence.
        builder.Services.AddSingleton<AppUpdateSweepService>();
        builder.Services.AddHostedService<AppUpdateSweepScheduler>();
        builder.Services.AddCors();
        // Registered after AddCors so it wins over the default provider it TryAdds. The Shell policy is
        // built per request because its origin now lives in Shell's app record, which the operator can
        // change without restarting Core — see ShellCorsPolicyProvider.
        builder.Services.AddSingleton<ICorsPolicyProvider, ShellCorsPolicyProvider>();
        builder.Services.Configure<ForwardedHeadersOptions>(options =>
        {
            options.ForwardedHeaders =
                ForwardedHeaders.XForwardedFor |
                ForwardedHeaders.XForwardedHost |
                ForwardedHeaders.XForwardedProto;
        });
        builder.Services.AddHostedService<ControlDiscoveryWriter>();
    }

    public static void MapEndpoints(WebApplication app)
    {
        app.UseForwardedHeaders();
        app.UseCors("HostyShell");

        app.MapGet("/healthz", () => CoreJson.Json(new HealthResponse("ok")));
        app.MapGet("/api/core/status", async (
            HttpRequest request,
            HostyCoreRuntimeConfig config,
            CoreSettingsService settings,
            ShellPublicOriginResolver shellOrigins,
            CloudflareIntegrationStore cloudflare,
            UserDirectoryStore users,
            IClock clock,
            CancellationToken cancellationToken) =>
        {
            // Detailed status (host paths, ingress config, warnings) is admin-only; anonymous callers —
            // including anyone who reaches core.<domain> through ingress — get only liveness/version.
            var user = await CoreSessionAuthorization.TryResolveSessionAsync(request, users, clock, cancellationToken);
            return CoreJson.Json(user is not null && string.Equals(user.Role, "host.admin", StringComparison.Ordinal)
                ? CoreStatusResponse.From(
                    config,
                    settings.Ingress,
                    await shellOrigins.ResolveAsync(cancellationToken),
                    await cloudflare.IsConnectedAsync(cancellationToken))
                : CoreStatusResponse.Public());
        });
        app.MapGet("/control/v1/core/status", async (HttpRequest request, HostyCoreRuntimeConfig config, CoreSettingsService settings, ShellPublicOriginResolver shellOrigins, CloudflareIntegrationStore cloudflare, ControlSecret secret, CancellationToken cancellationToken) =>
            await RequireControlSecret(request, secret, async () => CoreJson.Json(CoreStatusResponse.From(
                config,
                settings.Ingress,
                await shellOrigins.ResolveAsync(cancellationToken),
                await cloudflare.IsConnectedAsync(cancellationToken)))));
        app.MapPost("/control/v1/core/stop", (HttpRequest request, ControlSecret secret, IHostApplicationLifetime lifetime, CoreShutdownOptions shutdownOptions) =>
            RequireControlSecret(request, secret, () =>
            {
                // keepApps=true is the "light stop": Core exits without stopping its app containers, so a
                // Core-only restart/update never triggers the destructive per-app docker-stop sweep. The
                // running containers are re-adopted by the next Core at boot (image-matched).
                var keepApps = IsTruthy(request.Query["keepApps"]);
                shutdownOptions.KeepRuntimeApps = keepApps;
                lifetime.StopApplication();
                return CoreJson.Json(new StopResponse(keepApps ? "stopping-keep-apps" : "stopping"));
            }));

        if (app.Environment.IsDevelopment())
        {
            app.MapGet("/login", async (string? returnTo, UserDirectoryStore users, CancellationToken cancellationToken) =>
            {
                var state = await users.ReadAsync(cancellationToken);
                return Results.Content(RenderDevelopmentLoginPage(state.Users, returnTo: returnTo), "text/html");
            });
            app.MapPost("/login", async (
                HttpRequest request,
                HttpResponse response,
                HostyCoreRuntimeConfig config,
                ShellPublicOriginResolver shellOrigins,
                UserDirectoryStore users,
                IClock clock,
                AuthLifetimes lifetimes,
                CancellationToken cancellationToken) =>
            {
                var form = await request.ReadFormAsync(cancellationToken);
                var returnTo = form["returnTo"].ToString();
                var result = await AuthEndpoints.CreateSessionAsync(
                    form["userId"].ToString(),
                    secureCookie: false,
                    response,
                    users,
                    clock,
                    lifetimes,
                    cancellationToken);

                var shellOrigin = await shellOrigins.ResolveAsync(cancellationToken);
                if (result.Succeeded)
                {
                    return RedirectAfterLogin(returnTo, shellOrigin, config);
                }

                var state = await users.ReadAsync(cancellationToken);
                return Results.Content(
                    RenderDevelopmentLoginPage(state.Users, "Select an enabled local Hosty user.", returnTo),
                    "text/html",
                    Encoding.UTF8,
                    StatusCodes.Status403Forbidden);
            });
        }
        else
        {
            app.MapGet("/login", (string? returnTo) => Results.Content(
                RenderPasswordLoginPage(returnTo: returnTo),
                "text/html"));
            app.MapPost("/login", async (
                HttpRequest request,
                HttpResponse response,
                HostyCoreRuntimeConfig config,
                ShellPublicOriginResolver shellOrigins,
                LocalPasswordAuthService passwords,
                UserDirectoryStore users,
                IClock clock,
                AuthLifetimes lifetimes,
                CancellationToken cancellationToken) =>
            {
                var form = await request.ReadFormAsync(cancellationToken);
                var returnTo = form["returnTo"].ToString();
                var shellOrigin = await shellOrigins.ResolveAsync(cancellationToken);
                try
                {
                    var user = await passwords.AuthenticateAsync(
                        new LocalPasswordLoginRequest(
                            form["email"].ToString(),
                            form["password"].ToString()),
                        request.HttpContext.Connection.RemoteIpAddress?.ToString(),
                        cancellationToken);
                    var result = await AuthEndpoints.CreateSessionAsync(
                        user.Id,
                        secureCookie: request.IsHttps,
                        response,
                        users,
                        clock,
                        lifetimes,
                        cancellationToken);

                    return result.Succeeded
                        ? RedirectAfterLogin(returnTo, shellOrigin, config)
                        : Results.Content(
                            RenderPasswordLoginPage("Email or password is invalid.", returnTo),
                            "text/html",
                            Encoding.UTF8,
                            StatusCodes.Status403Forbidden);
                }
                catch (LocalPasswordAuthException ex)
                {
                    var message = ex.Code == "login_throttled"
                        ? ex.Message
                        : "Email or password is invalid.";
                    return Results.Content(
                        RenderPasswordLoginPage(message, returnTo),
                        "text/html",
                        Encoding.UTF8,
                        ex.StatusCode);
                }
            });
        }
        app.MapGet("/setup", async (string? setupToken, ShellPublicOriginResolver shellOrigins, CancellationToken cancellationToken) => Results.Content(
            RenderSetupPage(await shellOrigins.ResolveAsync(cancellationToken), setupToken),
            "text/html"));
        app.MapGet("/setup/invite", async (string? setupToken, ShellPublicOriginResolver shellOrigins, CancellationToken cancellationToken) => Results.Content(
            RenderInvitationPage(await shellOrigins.ResolveAsync(cancellationToken), setupToken),
            "text/html"));
        app.MapGet("/recovery", async (string? recoveryToken, ShellPublicOriginResolver shellOrigins, CancellationToken cancellationToken) => Results.Content(
            RenderRecoveryPage(await shellOrigins.ResolveAsync(cancellationToken), recoveryToken),
            "text/html"));
        // Logout's real path is the CSRF-protected POST /api/auth/logout the current Shell issues. This
        // GET stays for the old Shell (a <a href>/logout link) and bookmarks, but it must not be a
        // silent CSRF-logout vector: a stray <img src>/prefetch/hidden-iframe to /logout would otherwise
        // revoke the session. Fetch Metadata distinguishes those — an embedded subresource load carries
        // Sec-Fetch-Dest != "document" — so revoke only for a genuine top-level navigation (Dest
        // "document", or absent for non-browser clients) and never for an embedded load (C-L2). A host
        // may run without a Shell, so the redirect target is Core's own login page.
        app.MapGet("/logout", async (
            HttpRequest request,
            HttpResponse response,
            UserDirectoryStore users,
            AppSessionGrantStore grants,
            IClock clock,
            CancellationToken cancellationToken) =>
        {
            var fetchDest = request.Headers["Sec-Fetch-Dest"].ToString();
            var isEmbeddedSubresource = !string.IsNullOrEmpty(fetchDest) && !string.Equals(fetchDest, "document", StringComparison.Ordinal);
            if (!isEmbeddedSubresource)
            {
                await AuthEndpoints.LogoutAsync(request, response, users, grants, clock, cancellationToken);
            }

            return Results.Redirect("/login");
        });
        app.MapGet("/api/auth/callback/oidc", async (
            HostyCoreRuntimeConfig config,
            ShellPublicOriginResolver shellOrigins,
            CancellationToken cancellationToken) => Results.Content(RenderCorePage(
            "Hosty Core OIDC Callback",
            "Hosty Core owns external auth callbacks.",
            config,
            await shellOrigins.ResolveAsync(cancellationToken)), "text/html"));

        DomainEndpoints.Map(app);
        AuthEndpoints.Map(app);
        AccessTokenEndpoints.Map(app);
        AuthBootstrapEndpoints.Map(app);
        UserManagementEndpoints.Map(app);
        LifecycleEndpoints.Map(app);
        GlobalMountEndpoints.Map(app);
        CoreBootstrapEndpoints.Map(app);
        CoreSettingsEndpoints.Map(app);
        CoreRestartEndpoints.Map(app);
        CloudflareConnectionEndpoints.Map(app);
        CloudflarePublicationEndpoints.Map(app);
        SourceEndpoints.Map(app);
        ControlIdentityEndpoints.Map(app);
        AppDirectoryEndpoints.Map(app);
        AppAssetEndpoints.Map(app);
        AppBackupEndpoints.Map(app);
        AppSecretsEndpoints.Map(app);
        NotificationEndpoints.Map(app);
        EventStreamEndpoints.Map(app);
    }

    // Query-flag parsing for control endpoints: accepts a bare `?keepApps` (empty value) plus the usual
    // true/1/yes spellings, so both `?keepApps` and `?keepApps=true` mean the same thing.
    private static bool IsTruthy(Microsoft.Extensions.Primitives.StringValues value)
    {
        if (value.Count == 0)
        {
            return false;
        }

        var text = value.ToString();
        return text.Length == 0 ||
            text.Equals("true", StringComparison.OrdinalIgnoreCase) ||
            text.Equals("1", StringComparison.Ordinal) ||
            text.Equals("yes", StringComparison.OrdinalIgnoreCase);
    }

    internal static IResult RequireControlSecret(HttpRequest request, ControlSecret secret, Func<IResult> action)
    {
        if (!request.Headers.TryGetValue(ControlSecretHeader, out var submitted) ||
            !SecretComparison.HexEquals(secret.Value, submitted.ToString()))
        {
            return CoreJson.Json(new ErrorResponse("control_unauthorized", "Local control secret is missing or invalid."), statusCode: StatusCodes.Status401Unauthorized);
        }

        return action();
    }

    internal static async Task<IResult> RequireControlSecret(HttpRequest request, ControlSecret secret, Func<Task<IResult>> action)
    {
        if (!request.Headers.TryGetValue(ControlSecretHeader, out var submitted) ||
            !SecretComparison.HexEquals(secret.Value, submitted.ToString()))
        {
            return CoreJson.Json(new ErrorResponse("control_unauthorized", "Local control secret is missing or invalid."), statusCode: StatusCodes.Status401Unauthorized);
        }

        return await action();
    }

    private static string CreateControlSecret()
        => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();

    // One stylesheet for every page Core serves itself: login, setup, recovery, invitation, and the plain
    // status pages. They are the only UI Core has, and they are read in a phone browser and inside the
    // native client's sign-in sheet as often as in a desktop window.
    //
    // `border-box` is the load-bearing line. Under the default `content-box` the card's padding and border
    // are added to its declared width, so a card sized `100vw - 2rem` rendered 50px wider than the viewport
    // and every narrow window got a horizontal scrollbar over a clipped form.
    private const string PageStyles = """
      :root { color-scheme: light dark; }
      *, *::before, *::after { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; padding: 2rem 1rem; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; background: Canvas; color: CanvasText; }
      main { width: min(30rem, 100%); padding: 1.75rem; border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 12px; background: color-mix(in srgb, CanvasText 3%, Canvas); box-shadow: 0 1px 2px color-mix(in srgb, CanvasText 8%, transparent); }
      h1 { margin: 0 0 1.25rem; font-size: 1.3125rem; letter-spacing: -.01em; }
      p { margin: .5rem 0; }
      form { display: grid; gap: 1rem; margin: 0 0 1.25rem; }
      .field { display: grid; gap: .375rem; }
      label { font-size: .8125rem; font-weight: 600; color: color-mix(in srgb, CanvasText 72%, transparent); }
      input, select, button { width: 100%; font: inherit; padding: .55rem .7rem; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 8px; background: Canvas; color: CanvasText; }
      input:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid AccentColor; outline-offset: 1px; border-color: AccentColor; }
      button { cursor: pointer; font-weight: 600; margin-top: .25rem; border-color: transparent; background: CanvasText; color: Canvas; }
      button { background: AccentColor; color: AccentColorText; }
      button:hover { filter: brightness(1.1); }
      button:active { filter: brightness(.94); }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
      .meta { margin: 1.25rem 0 0; padding-top: 1rem; border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent); display: grid; gap: .375rem; font-size: .8125rem; color: color-mix(in srgb, CanvasText 65%, transparent); }
      .meta p { margin: 0; }
      .error { margin: 0 0 1.25rem; padding: .625rem .75rem; border: 1px solid color-mix(in srgb, #e5484d 45%, transparent); border-radius: 8px; background: color-mix(in srgb, #e5484d 12%, Canvas); font-weight: 600; }
      """;

    private static string RenderCorePage(string title, string message, HostyCoreRuntimeConfig config, string? shellOrigin)
    {
        var encodedTitle = HtmlEncoder.Default.Encode(title);
        var encodedMessage = HtmlEncoder.Default.Encode(message);

        return $$"""
          <!doctype html>
          <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>{{encodedTitle}}</title>
            <style>
          {{PageStyles}}
            </style>
          </head>
          <body>
            <main>
              <h1>{{encodedTitle}}</h1>
              <p>{{encodedMessage}}</p>
          {{RenderOriginMeta(config, shellOrigin)}}
            </main>
          </body>
          </html>
          """;
    }

    // The two origins a signed-in operator is shown: which Core answered, and where its web UI lives.
    // Not on `/login` — that page is reachable by anyone who can reach the host, and what it says about
    // the deployment should be nothing.
    private static string RenderOriginMeta(HostyCoreRuntimeConfig config, string? shellOrigin, string? hint = null)
    {
        var encodedCoreOrigin = HtmlEncoder.Default.Encode(config.EffectiveCorePublicOrigin);
        var encodedShellOrigin = RenderShellOriginText(shellOrigin);
        var hintLine = hint is null ? string.Empty : $"{Environment.NewLine}  <p>{HtmlEncoder.Default.Encode(hint)}</p>";

        return $"""
          <div class="meta">
            <p>Core origin: <code>{encodedCoreOrigin}</code></p>
            <p>Shell origin: <code>{encodedShellOrigin}</code></p>{hintLine}
          </div>
          """;
    }

    // Reflect the login continuation into the form only when it passes the same allow-list the
    // post-login redirect enforces, so a rejected value is never echoed back into the page.
    private static string RenderReturnToField(string? returnTo)
        => AuthEndpoints.IsAllowedLoginContinuation(returnTo)
            ? $"""<input type="hidden" name="returnTo" value="{HtmlEncoder.Default.Encode(returnTo!)}">"""
            : string.Empty;

    private static string RenderDevelopmentLoginPage(
        IReadOnlyList<HostUserRecord> users,
        string? error = null,
        string? returnTo = null)
    {
        var returnToField = RenderReturnToField(returnTo);
        var enabledUsers = users.Where(user => !user.Disabled).ToArray();
        var options = string.Join(Environment.NewLine, enabledUsers.Select(user =>
        {
            var encodedId = HtmlEncoder.Default.Encode(user.Id);
            var encodedLabel = HtmlEncoder.Default.Encode($"{user.DisplayName} - {user.Email} - {user.Role}");
            return $"""<option value="{encodedId}">{encodedLabel}</option>""";
        }));
        var encodedError = error is null
            ? string.Empty
            : $"""<p class="error">{HtmlEncoder.Default.Encode(error)}</p>""";
        var form = enabledUsers.Length == 0
            ? """<p>No enabled local Hosty users are available.</p>"""
            : $$"""
              <form method="post" action="/login">
                {{returnToField}}
                <div class="field">
                  <label for="userId">Development user</label>
                  <select id="userId" name="userId">{{options}}</select>
                </div>
                <button type="submit">Start development session</button>
              </form>
              """;

        return $$"""
          <!doctype html>
          <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Hosty Login</title>
            <style>
          {{PageStyles}}
            </style>
          </head>
          <body>
            <main>
              <h1>Hosty Login</h1>
              <p>Development-only local session helper.</p>
              {{encodedError}}
              {{form}}
              <div class="meta">
                <p>Production authentication remains owned by Core auth providers.</p>
              </div>
            </main>
          </body>
          </html>
          """;
    }

    private static string RenderPasswordLoginPage(string? error = null, string? returnTo = null)
    {
        var returnToField = RenderReturnToField(returnTo);
        var encodedError = error is null
            ? string.Empty
            : $"""<p class="error">{HtmlEncoder.Default.Encode(error)}</p>""";

        return $$"""
          <!doctype html>
          <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Hosty Login</title>
            <style>
          {{PageStyles}}
            </style>
          </head>
          <body>
            <main>
              <h1>Hosty Login</h1>
              {{encodedError}}
              <form method="post" action="/login">
                {{returnToField}}
                <div class="field">
                  <label for="email">Email</label>
                  <input id="email" name="email" type="email" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus>
                </div>
                <div class="field">
                  <label for="password">Password</label>
                  <input id="password" name="password" type="password" autocomplete="current-password" required>
                </div>
                <button type="submit">Sign in</button>
              </form>
              <div class="meta">
                <p>Use recovery from the local CLI if this account does not have a password yet.</p>
              </div>
            </main>
          </body>
          </html>
          """;
    }

    // Where a freshly signed-in browser goes. A Core-relative app-open continuation wins; otherwise Shell.
    // With no Shell installed there is no destination at all, so say that on Core's own page rather than
    // bouncing to a dead origin — Core serves no UI of its own beyond these auth pages by design.
    private static IResult RedirectAfterLogin(string? returnTo, string? shellOrigin, HostyCoreRuntimeConfig config)
        => AuthEndpoints.ResolveLoginRedirect(returnTo, shellOrigin) is { } target
            ? Results.Redirect(target)
            : Results.Content(
                RenderCorePage("Hosty Core", "Signed in. This host has no web UI installed.", config, shellOrigin),
                "text/html");

    // The Shell origin as a JavaScript literal: a quoted string, or `null` when this host has no Shell
    // installed (it is an optional distribution app). The pages branch on it rather than navigating to a
    // dead origin, which is what the old `http://localhost:{ShellPort}` fallback produced.
    private static string RenderShellOriginLiteral(string? shellOrigin)
        => shellOrigin is null ? "null" : $"'{JavaScriptEncoder.Default.Encode(shellOrigin)}'";

    // Same for prose: the origin, or a plain statement that there is none.
    private static string RenderShellOriginText(string? shellOrigin)
        => HtmlEncoder.Default.Encode(shellOrigin ?? "not installed");

    private static string RenderSetupPage(string? shellOrigin, string? setupToken)
    {
        var encodedToken = HtmlEncoder.Default.Encode(setupToken ?? "");
        var shellOriginLiteral = RenderShellOriginLiteral(shellOrigin);

        return $$"""
          <!doctype html>
          <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Hosty Core Setup</title>
            <style>
          {{PageStyles}}
            </style>
          </head>
          <body>
            <main>
              <h1>Hosty Core Setup</h1>
              <p id="message"></p>
              <form id="setup-form">
                <input type="hidden" id="setup-token" value="{{encodedToken}}">
                <div class="field">
                  <label for="email">Email</label>
                  <input id="email" name="email" type="email" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus>
                </div>
                <div class="field">
                  <label for="display-name">Display name</label>
                  <input id="display-name" name="displayName" autocomplete="name">
                </div>
                <div class="field">
                  <label for="password">Password</label>
                  <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8">
                </div>
                <div class="field">
                  <label for="confirm-password">Confirm password</label>
                  <input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" required minlength="8">
                </div>
                <button type="submit">Create administrator</button>
              </form>
            </main>
            <script>
              const form = document.getElementById('setup-form');
              const message = document.getElementById('message');
              form.addEventListener('submit', async (event) => {
                event.preventDefault();
                message.className = '';
                message.textContent = 'Creating administrator...';
                const password = document.getElementById('password').value;
                const confirmPassword = document.getElementById('confirm-password').value;
                if (password !== confirmPassword) {
                  message.className = 'error';
                  message.textContent = 'Passwords do not match.';
                  return;
                }
                const response = await fetch('/api/auth/bootstrap', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    setupToken: document.getElementById('setup-token').value,
                    email: document.getElementById('email').value,
                    displayName: document.getElementById('display-name').value || undefined,
                    password
                  })
                });
                if (!response.ok) {
                  const error = await response.json().catch(() => ({}));
                  message.className = 'error';
                  message.textContent = error.message || 'Administrator setup could not be completed.';
                  return;
                }
                const shellOrigin = {{shellOriginLiteral}};
                if (!shellOrigin) {
                  message.className = '';
                  message.textContent = 'Done. This host has no web UI installed, so there is nowhere to send you.';
                  return;
                }
                window.location.href = shellOrigin;
              });
            </script>
          </body>
          </html>
          """;
    }

    private static string RenderRecoveryPage(string? shellOrigin, string? recoveryToken)
    {
        var encodedToken = HtmlEncoder.Default.Encode(recoveryToken ?? "");
        var shellOriginLiteral = RenderShellOriginLiteral(shellOrigin);

        return $$"""
          <!doctype html>
          <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Hosty Core Recovery</title>
            <style>
          {{PageStyles}}
            </style>
          </head>
          <body>
            <main>
              <h1>Hosty Core Recovery</h1>
              <p id="message"></p>
              <form id="recovery-form">
                <input type="hidden" id="recovery-token" value="{{encodedToken}}">
                <div class="field">
                  <label for="email">Email</label>
                  <input id="email" name="email" type="email" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus>
                </div>
                <div class="field">
                  <label for="display-name">Display name</label>
                  <input id="display-name" name="displayName" autocomplete="name">
                </div>
                <div class="field">
                  <label for="password">Password</label>
                  <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8">
                </div>
                <div class="field">
                  <label for="confirm-password">Confirm password</label>
                  <input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" required minlength="8">
                </div>
                <button type="submit">Restore administrator</button>
              </form>
            </main>
            <script>
              const form = document.getElementById('recovery-form');
              const message = document.getElementById('message');
              form.addEventListener('submit', async (event) => {
                event.preventDefault();
                message.className = '';
                message.textContent = 'Restoring administrator...';
                const password = document.getElementById('password').value;
                const confirmPassword = document.getElementById('confirm-password').value;
                if (password !== confirmPassword) {
                  message.className = 'error';
                  message.textContent = 'Passwords do not match.';
                  return;
                }
                const response = await fetch('/api/auth/recovery', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    recoveryToken: document.getElementById('recovery-token').value,
                    email: document.getElementById('email').value,
                    displayName: document.getElementById('display-name').value || undefined,
                    password
                  })
                });
                if (!response.ok) {
                  const error = await response.json().catch(() => ({}));
                  message.className = 'error';
                  message.textContent = error.message || 'Administrator recovery could not be completed.';
                  return;
                }
                const shellOrigin = {{shellOriginLiteral}};
                if (!shellOrigin) {
                  message.className = '';
                  message.textContent = 'Done. This host has no web UI installed, so there is nowhere to send you.';
                  return;
                }
                window.location.href = shellOrigin;
              });
            </script>
          </body>
          </html>
          """;
    }

    private static string RenderInvitationPage(string? shellOrigin, string? setupToken)
    {
        var encodedToken = HtmlEncoder.Default.Encode(setupToken ?? "");
        var shellOriginLiteral = RenderShellOriginLiteral(shellOrigin);

        return $$"""
          <!doctype html>
          <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Hosty Core Invitation</title>
            <style>
          {{PageStyles}}
            </style>
          </head>
          <body>
            <main>
              <h1>Hosty Core Invitation</h1>
              <p>Core owns invitation acceptance and session creation.</p>
              <p id="message"></p>
              <form id="invite-form">
                <input type="hidden" id="setup-token" value="{{encodedToken}}">
                <div class="field">
                  <label for="display-name">Display name</label>
                  <input id="display-name" name="displayName" autocomplete="name" autofocus>
                </div>
                <div class="field">
                  <label for="password">Password</label>
                  <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8">
                </div>
                <div class="field">
                  <label for="confirm-password">Confirm password</label>
                  <input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" required minlength="8">
                </div>
                <button type="submit">Accept invitation</button>
              </form>
            </main>
            <script>
              const form = document.getElementById('invite-form');
              const message = document.getElementById('message');
              form.addEventListener('submit', async (event) => {
                event.preventDefault();
                message.className = '';
                message.textContent = 'Accepting invitation...';
                const password = document.getElementById('password').value;
                const confirmPassword = document.getElementById('confirm-password').value;
                if (password !== confirmPassword) {
                  message.className = 'error';
                  message.textContent = 'Passwords do not match.';
                  return;
                }
                const response = await fetch('/api/auth/invitations/accept', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    setupToken: document.getElementById('setup-token').value,
                    displayName: document.getElementById('display-name').value || undefined,
                    password
                  })
                });
                if (!response.ok) {
                  const error = await response.json().catch(() => ({}));
                  message.className = 'error';
                  message.textContent = error.message || 'Invitation could not be accepted.';
                  return;
                }
                const shellOrigin = {{shellOriginLiteral}};
                if (!shellOrigin) {
                  message.className = '';
                  message.textContent = 'Done. This host has no web UI installed, so there is nowhere to send you.';
                  return;
                }
                window.location.href = shellOrigin;
              });
            </script>
          </body>
          </html>
          """;
    }
}

internal sealed record HostyCoreRuntimeConfig(
    string DataRoot,
    string RunDirectory,
    string ControlDiscoveryPath,
    int CorePort,
    string ListenUrl,
    string? CorePublicOrigin,
    string RuntimePublicHost,
    string? ShellSourceOverridePath,
    bool ShellAutostart,
    string? TrustedProxySecret = null,
    // The cloudflared config.yml output path stays a launch-only knob (like the data root): it is
    // plumbing, not a behavior setting. The provider/base-domain/tunnel/credentials are live settings
    // owned by CoreSettingsService (IngressSettings), not baked into this startup snapshot.
    string? IngressConfigPath = null,
    // Shell/collector runtime profile as an ambient dev/fork-only override
    // (HOSTY_SHELL_BOOTSTRAP_RUNTIME, HOSTY_COLLECTOR_BOOTSTRAP_RUNTIME). Removed from `hosty config`:
    // a system app's runtime profile is a normal per-app choice. Null when unset — the manifest
    // default chooses on first install and the operator's `switch-runtime` choice is preserved on
    // later boots. Only a source tree / air-gapped fork sets these to pin a non-default profile.
    string? ShellBootstrapRuntime = null,
    string? CollectorBootstrapRuntime = null,
    // Raw legacy bootstrap env (per-app manifest paths and enable flags), captured verbatim for the
    // distribution merge's deprecation layer. Which apps bootstrap — and from where — is otherwise
    // decided by the distribution list + operator choices, not by this config.
    LegacyBootstrapEnv? Legacy = null)
{
    public string EffectiveCorePublicOrigin => CorePublicOrigin ?? ListenUrl;

    // No EffectiveShellPublicOrigin: where Shell is reachable is resolved from Shell's own app record
    // (ShellPublicOriginResolver), not from Core's launch config. Shell is an optional distribution app,
    // so Core carrying a config for it — and synthesising a localhost fallback for a host that may have
    // no Shell at all — was the bug. ShellPublicOrigin survives only as the transitional seed that the
    // bootstrap stamps into the record's public-origin setting; it retires with the CLI's other per-app
    // launch settings.

    public string EffectiveIngressConfigPath => IngressConfigPath ?? Path.Combine(DataRoot, "core", "ingress", "config.yml");

    public static HostyCoreRuntimeConfig FromEnvironment(IHostEnvironment environment)
    {
        var dataRoot = NormalizePath(
            ReadFirst("HOSTY_DATA_ROOT", "HOSTY_HOME") ??
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".hosty"));
        var coreRoot = Path.Combine(dataRoot, "core");
        var runDirectory = Path.Combine(coreRoot, "run");
        var corePort = ReadPort("HOSTY_CORE_PORT", 7070);
        var listenUrl = NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_CORE_URL")) ??
            NormalizeOptional(Environment.GetEnvironmentVariable("ASPNETCORE_URLS")) ??
            $"http://localhost:{corePort}";
        var corePublicOrigin = NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_CORE_PUBLIC_ORIGIN"));
        // The host Core advertises (and dials) for an app's published loopback port. Must be the IPv4
        // loopback literal, NOT "localhost": docker publishes these ports on 127.0.0.1 only, but on
        // hosts where "localhost" resolves to ::1 first (Windows, dual-stack Linux) .NET's HttpClient
        // connects to resolved addresses sequentially with no Happy-Eyeballs fallback — it stalls on
        // ::1 (nothing listens there) until the request times out, and every telemetry/health read to a
        // runtime app silently degrades to empty. Overridable for hosts that publish on another address.
        var runtimePublicHost = NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_RUNTIME_PUBLIC_HOST")) ?? "127.0.0.1";
        // Legacy per-app bootstrap env, captured verbatim (no default substitution): the distribution
        // list owns the defaults now, and the merge only honors these as deprecated explicit
        // overrides. The marketplace variable tracks raw presence because present-but-empty is a
        // meaningful explicit disable (NormalizeOptional would erase that distinction).
        var rawMarketplaceManifestPath = Environment.GetEnvironmentVariable("HOSTY_MARKETPLACE_MANIFEST_PATH");
        var legacy = new LegacyBootstrapEnv(
            ShellManifestPath: NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_SHELL_MANIFEST_PATH")),
            ShellBootstrapEnabled: ReadOptionalBoolean("HOSTY_SHELL_BOOTSTRAP_ENABLED"),
            CollectorManifestPath: NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_COLLECTOR_MANIFEST_PATH")),
            ObservabilityEnabled: ReadOptionalBoolean("HOSTY_OBSERVABILITY_ENABLED"),
            MarketplaceManifestPath: NormalizeOptional(rawMarketplaceManifestPath),
            MarketplaceManifestPathConfigured: rawMarketplaceManifestPath is not null);
        // Resolve to an absolute path: the config path is written by Core and read by cloudflared (run
        // from another cwd / as a service), which cannot resolve relative or ~ paths.
        var ingressConfigPath = NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_INGRESS_CONFIG_PATH")) is { } configPath
            ? NormalizePath(configPath)
            : null;

        return new HostyCoreRuntimeConfig(
            dataRoot,
            runDirectory,
            Path.Combine(runDirectory, "control.json"),
            corePort,
            listenUrl,
            corePublicOrigin,
            runtimePublicHost,
            NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_SHELL_SOURCE_OVERRIDE_PATH")),
            ReadBoolean("HOSTY_SHELL_AUTOSTART", defaultValue: true),
            NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_TRUSTED_PROXY_SECRET")),
            ingressConfigPath,
            // Ambient dev/fork-only override, null when unset (no "docker" default): unset lets the
            // manifest default choose and keeps reconciliation from fighting a switch-runtime choice.
            NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_SHELL_BOOTSTRAP_RUNTIME")),
            NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_COLLECTOR_BOOTSTRAP_RUNTIME")),
            legacy);
    }

    private static string? ReadFirst(params string[] names)
    {
        foreach (var name in names)
        {
            var value = NormalizeOptional(Environment.GetEnvironmentVariable(name));
            if (value is not null)
            {
                return value;
            }
        }

        return null;
    }

    private static string NormalizePath(string path)
    {
        if (path.StartsWith("~/", StringComparison.Ordinal) || path.StartsWith("~\\", StringComparison.Ordinal))
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            path = Path.Combine(home, path[2..]);
        }

        return Path.GetFullPath(path);
    }

    private static string? NormalizeOptional(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static int ReadPort(string name, int defaultValue)
    {
        var value = NormalizeOptional(Environment.GetEnvironmentVariable(name));
        if (value is null)
        {
            return defaultValue;
        }

        if (int.TryParse(value, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var port) &&
            port is > 0 and <= IPEndPoint.MaxPort)
        {
            return port;
        }

        throw new InvalidOperationException($"{name} must be an integer between 1 and {IPEndPoint.MaxPort}.");
    }

    private static bool ReadBoolean(string name, bool defaultValue)
    {
        var value = NormalizeOptional(Environment.GetEnvironmentVariable(name));
        if (value is null)
        {
            return defaultValue;
        }

        return value is "1" ||
            value.Equals("true", StringComparison.OrdinalIgnoreCase) ||
            value.Equals("enabled", StringComparison.OrdinalIgnoreCase) ||
            value.Equals("yes", StringComparison.OrdinalIgnoreCase);
    }

    // Like ReadBoolean but keeps "unset" distinct from any default — the legacy bootstrap layer only
    // acts on values the operator (or the current CLI) explicitly provided.
    private static bool? ReadOptionalBoolean(string name)
        => NormalizeOptional(Environment.GetEnvironmentVariable(name)) is null
            ? null
            : ReadBoolean(name, defaultValue: false);

    public IReadOnlyList<string> BuildPublicOriginWarnings()
    {
        var warnings = new List<string>();
        AddPublicOriginWarnings(warnings, "Core", CorePublicOrigin);
        return warnings;
    }

    private static void AddPublicOriginWarnings(List<string> warnings, string label, string? origin)
    {
        if (string.IsNullOrWhiteSpace(origin))
        {
            return;
        }

        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) ||
            !string.IsNullOrEmpty(uri.PathAndQuery.Trim('/')))
        {
            warnings.Add($"{label} public origin should be an absolute http(s) origin without a path.");
            return;
        }

        if (uri.Scheme == Uri.UriSchemeHttp && !IsLoopbackHost(uri.Host))
        {
            warnings.Add($"{label} public origin uses insecure HTTP on a non-loopback host. Use HTTPS before exposing it beyond local development.");
        }
    }

    private static bool IsLoopbackHost(string host)
    {
        if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return IPAddress.TryParse(host, out var address) && IPAddress.IsLoopback(address);
    }
}

internal enum RestartDecision
{
    Skip,
    Restart,
    GiveUp,
}

// Per-app crash-loop gate carried between supervision ticks: how many restarts have been attempted,
// the earliest time the next attempt is allowed (backoff), and whether the budget is exhausted.
internal sealed record RestartGateState(int Attempts, DateTimeOffset NextEligibleAt, bool GaveUp)
{
    public static readonly RestartGateState Initial = new(0, DateTimeOffset.MinValue, false);
}

internal sealed class RuntimeAppSupervisorService(
    HostyCoreRuntimeConfig config,
    AppRegistryStore apps,
    CoreLifecycleService lifecycle,
    SystemAppBootstrapService bootstrap,
    CoreShutdownOptions shutdownOptions,
    ILogger<RuntimeAppSupervisorService> logger,
    NotificationService? notifications = null) : BackgroundService
{
    private static readonly TimeSpan RuntimeAppShutdownTimeout = TimeSpan.FromSeconds(15);
    // How often to observe runtime-app health, reconcile RuntimeState, and surface transitions.
    private static readonly TimeSpan SuperviseInterval = TimeSpan.FromSeconds(15);
    // Upper bound on exponential restart backoff so a long-running crash loop still retries occasionally.
    private static readonly TimeSpan MaxRestartBackoff = TimeSpan.FromMinutes(5);
    // Last observed aggregate health per app, so a tick can detect transitions. In-memory only: a
    // Core restart re-baselines silently (the first observation of each app raises no notification).
    private readonly Dictionary<string, string> lastObservedHealth = new(StringComparer.Ordinal);
    // Per-app crash-loop gate (attempts + next eligible time + gave-up), driving restart backoff.
    private readonly Dictionary<string, RestartGateState> restartGates = new(StringComparer.Ordinal);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Yield();

        await ReclaimOrphanedRuntimeProcessesAsync(stoppingToken);
        await bootstrap.SeedBootAsync(stoppingToken);

        await BackfillManifestProjectionsAsync(stoppingToken);
        await MigratePortAssignmentsAsync(stoppingToken);
        await PurgeRetiredAdvisoriesAsync(stoppingToken);
        await RecoverStrandedLifecycleStatesAsync(stoppingToken);
        await RecoverInterruptedUpdatesAsync(stoppingToken);
        await StopAutostartDisabledAppsAsync(stoppingToken);
        await StartAutostartAppsAsync(stoppingToken);
        await lifecycle.ReconcileIngressAsync(stoppingToken);

        try
        {
            await SuperviseAsync(stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    // Periodic health supervision (Phase 1): each tick reconciles RuntimeState from observed health
    // and raises a host-admin advisory for any app whose aggregate health changed since the last tick.
    // The first tick fires after one interval (no immediate probe), so a fast-cancelled host never
    // observes — keeping startup and shutdown quiet.
    private async Task SuperviseAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(SuperviseInterval);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            await SuperviseTickAsync(stoppingToken);
        }
    }

    private async Task SuperviseTickAsync(CancellationToken cancellationToken)
    {
        // Apps with an active crash-loop gate are observed even while their reconciled state sits at
        // "stopped" during backoff, so retries and give-up keep advancing across ticks.
        var supervised = new HashSet<string>(restartGates.Keys, StringComparer.Ordinal);
        IReadOnlyList<AppHealthObservation> observations;
        try
        {
            observations = await lifecycle.ObserveRuntimeHealthAsync(supervised, cancellationToken);
        }
        catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(ex, "Runtime app supervision tick failed.");
            return;
        }

        var observed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var observation in observations)
        {
            observed.Add(observation.AppId);
            var previous = lastObservedHealth.GetValueOrDefault(observation.AppId);
            lastObservedHealth[observation.AppId] = observation.Status;
            if (previous is not null && !string.Equals(previous, observation.Status, StringComparison.Ordinal))
            {
                await NotifyHealthTransitionAsync(observation.AppId, previous, observation.Status, cancellationToken);
            }

            await ApplyRestartPolicyAsync(observation, cancellationToken);
        }

        // Forget apps no longer observed (stopped or removed) so a later restart re-baselines quietly.
        PruneUnobserved(lastObservedHealth, observed);
        PruneUnobserved(restartGates, observed);
    }

    private static void PruneUnobserved<T>(Dictionary<string, T> map, HashSet<string> observed)
    {
        foreach (var key in map.Keys.Where(id => !observed.Contains(id)).ToArray())
        {
            map.Remove(key);
        }
    }

    // Restarts an app the supervisor observed to have crashed, honoring its restart policy and a
    // per-app exponential-backoff crash-loop gate. Observing the app healthy clears the gate so a
    // future crash starts from a fresh budget.
    private async Task ApplyRestartPolicyAsync(AppHealthObservation observation, CancellationToken cancellationToken)
    {
        if (string.Equals(observation.Status, "healthy", StringComparison.Ordinal))
        {
            restartGates.Remove(observation.AppId);
            return;
        }

        // Only a full crash (all services exited -> "stopped") is auto-restarted in v1; partial
        // degradation is surfaced as an advisory but not acted on — restarting healthy services to
        // recover one is too blunt, and per-service restart is a later refinement.
        if (!string.Equals(observation.Status, "stopped", StringComparison.Ordinal) || !observation.RestartPolicy.Enabled)
        {
            return;
        }

        var gate = restartGates.GetValueOrDefault(observation.AppId, RestartGateState.Initial);
        var (decision, next) = EvaluateRestart(observation.RestartPolicy, gate, DateTimeOffset.UtcNow, MaxRestartBackoff);
        restartGates[observation.AppId] = next;

        switch (decision)
        {
            case RestartDecision.Restart:
                try
                {
                    await lifecycle.StartAsync(observation.AppId, cancellationToken);
                    logger.LogInformation("Supervisor restarted '{AppId}' after a crash (attempt {Attempt}/{Max}).",
                        observation.AppId, next.Attempts, observation.RestartPolicy.MaxRetries);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogWarning(ex, "Supervisor restart of '{AppId}' failed.", observation.AppId);
                }

                break;

            case RestartDecision.GiveUp:
                // Drop the gate so the abandoned app (left at "stopped") stops being supervised and
                // settles, instead of being observed and re-evaluated to GiveUp on every later tick.
                restartGates.Remove(observation.AppId);
                await NotifyRestartGiveUpAsync(observation.AppId, observation.RestartPolicy.MaxRetries, cancellationToken);
                break;
        }
    }

    // Pure crash-loop gate: given the policy, the per-app restart state, and now, decides whether to
    // restart, give up, or wait. Backoff grows exponentially from the base (base * 2^attempts), capped
    // at maxBackoff. Extracted as a static so the decision is unit-testable without timers or IO.
    internal static (RestartDecision Decision, RestartGateState NextState) EvaluateRestart(
        RuntimeRestartPolicy policy, RestartGateState state, DateTimeOffset now, TimeSpan maxBackoff)
    {
        if (!policy.Enabled || state.GaveUp)
        {
            return (RestartDecision.Skip, state);
        }

        if (state.Attempts >= policy.MaxRetries)
        {
            return (RestartDecision.GiveUp, state with { GaveUp = true });
        }

        if (now < state.NextEligibleAt)
        {
            return (RestartDecision.Skip, state);
        }

        var backoffSeconds = Math.Min(policy.BackoffSeconds * Math.Pow(2, state.Attempts), maxBackoff.TotalSeconds);
        return (RestartDecision.Restart, new RestartGateState(state.Attempts + 1, now.AddSeconds(backoffSeconds), false));
    }

    private async Task NotifyRestartGiveUpAsync(string appId, int maxRetries, CancellationToken cancellationToken)
    {
        if (notifications is null)
        {
            return;
        }

        try
        {
            await notifications.PublishAsync(
                new AppScope(appId), NotificationService.BroadcastTarget, NotificationService.AudienceHostAdmin,
                "error",
                $"'{appId}' is crash-looping",
                $"'{appId}' kept exiting and was restarted {maxRetries} time(s) without recovering. Hosty has stopped restarting it — check its logs and start it manually once fixed.",
                link: null,
                dedupeKey: $"restart-giveup:{appId}",
                cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Failed to publish crash-loop advisory for {AppId}.", appId);
        }
    }

    private async Task NotifyHealthTransitionAsync(string appId, string previous, string current, CancellationToken cancellationToken)
    {
        if (notifications is null)
        {
            return;
        }

        var (level, title, body) = DescribeHealthTransition(appId, previous, current);
        if (level is null)
        {
            return;
        }

        try
        {
            await notifications.PublishAsync(
                new AppScope(appId), NotificationService.BroadcastTarget, NotificationService.AudienceHostAdmin,
                level, title!, body, link: null,
                dedupeKey: $"health-transition:{appId}:{current}",
                cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Failed to publish health transition advisory for {AppId}.", appId);
        }
    }

    // Decides whether an aggregate health change is worth a host-admin advisory and how to phrase it.
    // Moves into the transient "starting" or ambiguous "unknown" states are intentionally silent, as
    // is the normal startup hop starting -> healthy. "stopped" here means an unexpected exit: a
    // running app is only observed while Core still believes it is running, so an operator-initiated
    // stop leaves the observed set before it is ever seen as a transition here.
    internal static (string? Level, string? Title, string? Body) DescribeHealthTransition(string appId, string previous, string current)
        => current switch
        {
            "healthy" when !string.Equals(previous, "starting", StringComparison.Ordinal) =>
                ("success", $"'{appId}' recovered", $"'{appId}' is healthy again (was {previous})."),
            "degraded" =>
                ("warning", $"'{appId}' is degraded", $"'{appId}' is running but at least one service is failing its health check."),
            "unhealthy" =>
                ("warning", $"'{appId}' is partially down", $"'{appId}' has a service down while others keep running. Check its logs."),
            "stopped" =>
                ("error", $"'{appId}' stopped unexpectedly", $"'{appId}' was running but all of its services have exited. Check its logs."),
            _ => (null, null, null),
        };

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);

        // Keep-apps light stop: leave the app containers running so a Core-only restart/update does not
        // churn them (and cannot get wedged abandoning a slow docker-stop sweep). The next Core adopts
        // the still-running, image-matched containers at boot instead of recreating them.
        if (shutdownOptions.KeepRuntimeApps)
        {
            logger.LogInformation(
                "Hosty Core shutdown requested with keep-apps: leaving runtime app containers running for adoption on the next start.");
            return;
        }

        await StopRuntimeAppsAsync(cancellationToken);
    }

    private async Task StartAutostartAppsAsync(CancellationToken cancellationToken)
    {
        try
        {
            var results = await lifecycle.StartAutostartAppsAsync(cancellationToken);
            foreach (var result in results)
            {
                if (result.Succeeded)
                {
                    logger.LogInformation("Hosty autostart completed for runtime app {AppId}.", result.AppId);
                }
                else
                {
                    logger.LogWarning(
                        "Hosty autostart failed for runtime app {AppId}: {ErrorCode} {Message}",
                        result.AppId,
                        result.ErrorCode,
                        result.Message);
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        {
            logger.LogWarning(ex, "Hosty runtime app autostart did not complete.");
        }
    }

    // Dedupe-key prefixes of advisories that are no longer published because the condition they
    // described became app state. Cross-app dependency status now rides on the app summary and is
    // rendered beside the app, so the old start-time advisories are stale by construction — and the
    // notification store has no revoke, so nothing else would ever remove them.
    private static readonly string[] RetiredAdvisoryDedupePrefixes =
    [
        "dependency-missing:",
        "dependency-stopped:",
        "dependency-endpoint:",
    ];

    // One-time cleanup of advisories retired by an upgrade. Idempotent (a second boot finds nothing)
    // and best-effort — leftover notifications are cosmetic, and failing boot over them would not be.
    private async Task PurgeRetiredAdvisoriesAsync(CancellationToken cancellationToken)
    {
        if (notifications is null)
        {
            return;
        }

        try
        {
            var purged = await notifications.PurgeByDedupePrefixAsync(RetiredAdvisoryDedupePrefixes, cancellationToken);
            if (purged > 0)
            {
                logger.LogInformation(
                    "Removed {Count} retired dependency advisory notification(s); dependency status is now shown on the app itself.",
                    purged);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException)
        {
            logger.LogWarning(ex, "Retired-advisory cleanup did not complete.");
        }
    }

    // Boot sweep for runtime states left mid-transition by a Core stop or crash. Sequenced before
    // autostart reconciliation so it never fights a start this same boot is about to perform.
    // Best-effort — a recovery failure must never abort boot.
    private async Task RecoverStrandedLifecycleStatesAsync(CancellationToken cancellationToken)
    {
        try
        {
            var recovered = await lifecycle.RecoverStrandedLifecycleStatesAsync(cancellationToken);
            if (recovered > 0)
            {
                logger.LogWarning("Reset {Count} runtime app state(s) left mid-transition by the previous Core stop.", recovered);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException)
        {
            logger.LogWarning(ex, "Stranded lifecycle-state recovery did not complete.");
        }
    }

    // Boot sweep for background applies interrupted by a Core stop (plan-first updates phase 3):
    // flips stuck "updating" records to failed-for-re-review before autostart reconciliation reads
    // them. Best-effort — a recovery failure must never abort boot.
    private async Task RecoverInterruptedUpdatesAsync(CancellationToken cancellationToken)
    {
        try
        {
            var recovered = await lifecycle.RecoverInterruptedUpdatesAsync(cancellationToken);
            if (recovered > 0)
            {
                logger.LogWarning("Marked {Count} app update(s) interrupted by the previous Core stop as failed.", recovered);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException)
        {
            logger.LogWarning(ex, "Interrupted-update recovery did not complete.");
        }
    }

    // Manifest-projection backfill: re-run the manifest→record projections for records written by a
    // different Core build, before autostart reconciliation (start ordering reads Provides) and before
    // clients query the registry. Best-effort — a failure is logged and startup continues; an affected
    // record keeps its stale projections until the next boot or a reviewed update rebuilds it.
    private async Task BackfillManifestProjectionsAsync(CancellationToken cancellationToken)
    {
        try
        {
            var healed = await lifecycle.BackfillManifestProjectionsAsync(cancellationToken);
            if (healed > 0)
            {
                logger.LogInformation("Rebuilt manifest projections for {Count} runtime app record(s) written by a different Core build.", healed);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        // Same tolerance as the port backfill below: InvalidOperationException covers a record removed
        // between the list snapshot and its per-app write.
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException)
        {
            logger.LogWarning(ex, "Hosty manifest-projection backfill did not complete.");
        }
    }

    // Install-time port reservations: backfill persistent port assignments from stored endpoint
    // URLs before autostart reconciliation consumes them. Best-effort — a failure is logged and startup
    // continues (start still resolves ports as it does today when a record has no assignments yet).
    private async Task MigratePortAssignmentsAsync(CancellationToken cancellationToken)
    {
        try
        {
            var migrated = await lifecycle.MigratePortAssignmentsAsync(cancellationToken);
            if (migrated > 0)
            {
                logger.LogInformation("Backfilled port assignments for {Count} runtime app(s).", migrated);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        // Best-effort backfill must never abort boot. Beyond the storage exceptions the sibling helpers
        // handle, tolerate InvalidOperationException — UpdateAppAsync throws it when a record is removed
        // between the list snapshot and its per-app write.
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException)
        {
            logger.LogWarning(ex, "Hosty port assignment backfill did not complete.");
        }
    }

    // Kills localCommand process trees a prior Core left orphaned before any app is (re)started, so a
    // reclaimed app's port is free for its own restart below. Best-effort: a failure is logged and
    // startup continues (the pre-start stop loop's own reclaim is a second line of defense per app).
    private async Task ReclaimOrphanedRuntimeProcessesAsync(CancellationToken cancellationToken)
    {
        try
        {
            var reclaimed = await lifecycle.ReclaimOrphanedLocalCommandProcessesAsync(cancellationToken);
            if (reclaimed > 0)
            {
                logger.LogInformation("Reclaimed {Count} orphaned localCommand process tree(s) left by a previous Core.", reclaimed);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        {
            logger.LogWarning(ex, "Hosty orphaned localCommand process reclaim did not complete.");
        }
    }

    private async Task StopAutostartDisabledAppsAsync(CancellationToken cancellationToken)
    {
        try
        {
            var results = await lifecycle.StopAutostartDisabledAppsAsync(cancellationToken);
            foreach (var result in results.Where(result => !result.Succeeded))
            {
                logger.LogWarning(
                    "Hosty startup stop failed for autostart-disabled runtime app {AppId}: {ErrorCode} {Message}",
                    result.AppId,
                    result.ErrorCode,
                    result.Message);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        {
            logger.LogWarning(ex, "Hosty autostart-disabled runtime app stop did not complete.");
        }
    }

    private async Task StopRuntimeAppsAsync(CancellationToken hostShutdownToken)
    {
        // The sweep deliberately does NOT link to the host shutdown token. Kestrel stops before this
        // service, and one in-flight request that never ends on its own (an open notification SSE
        // stream) makes Kestrel eat the entire HostOptions.ShutdownTimeout budget — the token then
        // arrives here already cancelled and a linked sweep would be skipped outright, leaving every
        // container and localCommand tree running. The fixed budget below still bounds the sweep so
        // a wedged app can never hold the process (and therefore the listening port) open
        // indefinitely: when it is hit we abandon the remaining stops and let shutdown continue.
        if (hostShutdownToken.IsCancellationRequested)
        {
            logger.LogWarning(
                "Host shutdown budget was exhausted before the runtime app stop sweep started (a held connection can cause this); running the sweep on its own {Timeout} budget.",
                RuntimeAppShutdownTimeout);
        }

        using var timeoutCts = new CancellationTokenSource(RuntimeAppShutdownTimeout);
        try
        {
            var results = await lifecycle.StopRuntimeAppsAsync(timeoutCts.Token);
            foreach (var result in results.Where(result => !result.Succeeded))
            {
                logger.LogWarning(
                    "Hosty shutdown stop failed for runtime app {AppId}: {ErrorCode} {Message}",
                    result.AppId,
                    result.ErrorCode,
                    result.Message);
            }
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested)
        {
            logger.LogWarning(
                "Hosty runtime app shutdown stop exceeded {Timeout} and was abandoned so Core can release its port.",
                RuntimeAppShutdownTimeout);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        {
            logger.LogWarning(ex, "Hosty runtime app shutdown stop did not complete.");
        }
    }
}

internal sealed class ControlDiscoveryWriter(
    HostyCoreRuntimeConfig config,
    ControlSecret secret,
    IHostApplicationLifetime lifetime,
    ILogger<ControlDiscoveryWriter> logger) : IHostedService
{
    // Per-process ownership token written into control.json. RemoveDiscovery only deletes the file
    // when the on-disk nonce still matches, so a departing instance (a restart's old Core, or a
    // second start that lost the bind) can never delete the file a newer, live Core just wrote and
    // strand the CLI. This complements the write guard (only ApplicationStarted writes).
    private readonly string nonce = Guid.NewGuid().ToString("N");

    public Task StartAsync(CancellationToken cancellationToken)
    {
        // Tie the discovery file to the host lifecycle rather than to hosted-service
        // start/stop. ApplicationStarted only fires once the listener has bound, so a
        // failed start (e.g. the port is already taken by another Core) never writes —
        // and therefore can never clobber the running Core's discovery and strand the
        // CLI. ApplicationStopped removes it once shutdown has fully completed.
        lifetime.ApplicationStarted.Register(WriteDiscovery);
        lifetime.ApplicationStopped.Register(RemoveDiscovery);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private void WriteDiscovery()
    {
        try
        {
            SecureFileSystem.EnsurePrivateDirectory(config.RunDirectory);
            var discovery = new ControlDiscoveryDocument(
                SchemaVersion: 2,
                Component: "hosty-core",
                Transport: "http-loopback",
                Endpoint: config.ListenUrl,
                ControlBaseUrl: $"{config.ListenUrl.TrimEnd('/')}/control/v1",
                RequiredHeaders: new Dictionary<string, string>
                {
                    ["X-Hosty-Control-Secret"] = secret.Value,
                },
                StartedAt: DateTimeOffset.UtcNow,
                // PID lets the CLI tell a live Core from a stale file left by a hard kill; Nonce lets
                // this writer prove the file is still its own before removing it on shutdown.
                ProcessId: Environment.ProcessId,
                Nonce: nonce);

            var json = JsonSerializer.Serialize(
                discovery,
                JsonOptions.GetTypeInfo(typeof(ControlDiscoveryDocument)) as JsonTypeInfo<ControlDiscoveryDocument>
                    ?? throw new NotSupportedException(
                        $"Type '{nameof(ControlDiscoveryDocument)}' is not registered in {nameof(CoreJsonSerializerContext)}."));
            using (var stream = SecureFileSystem.CreatePrivateFile(config.ControlDiscoveryPath, FileMode.Create))
            {
                stream.Write(Encoding.UTF8.GetBytes(json));
            }

            SecureFileSystem.TryRestrictFile(config.ControlDiscoveryPath);
            logger.LogInformation("Hosty Core control discovery written to {Path}", config.ControlDiscoveryPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning(ex, "Unable to write Hosty Core control discovery at {Path}", config.ControlDiscoveryPath);
        }
    }

    private void RemoveDiscovery()
    {
        try
        {
            if (!File.Exists(config.ControlDiscoveryPath))
            {
                return;
            }

            // Only delete the file if it is still the one this process wrote. A newer Core (restart
            // race or double start) overwrites control.json with its own nonce; removing it then
            // would delete the live Core's discovery and leave the CLI blind (the exact failure the
            // write guard already prevents on the write side).
            if (!OwnsDiscoveryFile(config.ControlDiscoveryPath, nonce))
            {
                logger.LogInformation(
                    "Hosty Core control discovery at {Path} belongs to another Core instance; leaving it in place.",
                    config.ControlDiscoveryPath);
                return;
            }

            File.Delete(config.ControlDiscoveryPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning(ex, "Unable to remove Hosty Core control discovery at {Path}", config.ControlDiscoveryPath);
        }
    }

    // True only when control.json exists and still carries this process's nonce. A missing,
    // unreadable, or differently-owned file returns false so a departing instance never deletes a
    // file it cannot prove it owns.
    internal static bool OwnsDiscoveryFile(string path, string nonce)
    {
        try
        {
            if (!File.Exists(path))
            {
                return false;
            }

            var json = File.ReadAllText(path);
            var existing = JsonSerializer.Deserialize(
                json,
                JsonOptions.GetTypeInfo(typeof(ControlDiscoveryDocument)) as JsonTypeInfo<ControlDiscoveryDocument>
                    ?? throw new NotSupportedException(
                        $"Type '{nameof(ControlDiscoveryDocument)}' is not registered in {nameof(CoreJsonSerializerContext)}."));
            return existing is not null && string.Equals(existing.Nonce, nonce, StringComparison.Ordinal);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return false;
        }
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        TypeInfoResolver = CoreJsonSerializerContext.Default,
    };
}

internal sealed record ControlSecret(string Value);

internal sealed record ControlDiscoveryDocument(
    int SchemaVersion,
    string Component,
    string Transport,
    string Endpoint,
    string ControlBaseUrl,
    IReadOnlyDictionary<string, string> RequiredHeaders,
    DateTimeOffset StartedAt,
    int ProcessId = 0,
    string Nonce = "");

internal sealed class AppBackupRetentionScheduler(
    AppBackupService backups,
    AuditStore audit,
    IClock clock,
    ILogger<AppBackupRetentionScheduler> logger) : BackgroundService
{
    private static readonly TimeSpan CleanupInterval = TimeSpan.FromHours(6);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Yield();
        try
        {
            await RunCleanupAsync(stoppingToken);

            using var timer = new PeriodicTimer(CleanupInterval);
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                await RunCleanupAsync(stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Host is shutting down; exit quietly so we don't trip StopHost crit logging.
        }
    }

    // internal (not private) so a test can drive one pass without the timer, like the sibling schedulers.
    internal async Task RunCleanupAsync(CancellationToken cancellationToken)
    {
        try
        {
            var result = await backups.ApplyScheduledCleanupAsync(cancellationToken);
            if (result.Deleted.Count == 0 && result.Skipped.Count == 0)
            {
                logger.LogDebug("Hosty backup retention cleanup found no candidates.");
                return;
            }

            await audit.AppendAsync(new AuditRecord(
                Id: $"audit_{Guid.NewGuid():N}",
                Action: "backup.retention.cleanup",
                ResourceType: "backup.retention",
                ResourceId: null,
                Outcome: result.Skipped.Count == 0 ? "succeeded" : "partial",
                ActorUserId: null,
                CreatedAt: clock.UtcNow,
                Details: new Dictionary<string, string>
                {
                    ["planDigest"] = result.PlanDigest,
                    ["deleted"] = result.Deleted.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    ["skipped"] = result.Skipped.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
                }),
                cancellationToken);
            logger.LogInformation(
                "Hosty backup retention cleanup deleted {DeletedCount} candidates and skipped {SkippedCount}.",
                result.Deleted.Count,
                result.Skipped.Count);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception ex) when (ex is AppLifecycleException or IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        {
            logger.LogWarning(ex, "Hosty backup retention cleanup did not complete.");
        }
        catch (Exception ex)
        {
            // Nothing a sweep can hit is worth killing Core over: an exception escaping a
            // BackgroundService loop tears the host down in .NET 6+, so an unexpected failure
            // (a corrupt metadata file, a bug in the plan builder) is logged and retried next tick.
            logger.LogError(ex, "Hosty backup retention cleanup failed unexpectedly; retrying next cycle.");
        }
    }
}

// Permanently deletes disabled ("deleted") user records once they age past the configured retention
// window. Mirrors AppBackupRetentionScheduler / NotificationRetentionScheduler: a thin timer shell over
// a service method, running once at startup then on the interval. The window is read from
// CoreSettingsService each cycle, so an operator's save takes effect without a restart; a 0-day window
// disables the purge (manual deletion stays available).
internal sealed class UserRetentionScheduler(
    UserManagementService users,
    CoreSettingsService settings,
    AuditStore audit,
    IClock clock,
    ILogger<UserRetentionScheduler> logger) : BackgroundService
{
    private static readonly TimeSpan CleanupInterval = TimeSpan.FromHours(6);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Yield();
        try
        {
            await RunCleanupAsync(stoppingToken);

            using var timer = new PeriodicTimer(CleanupInterval);
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                await RunCleanupAsync(stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Host is shutting down; exit quietly so we don't trip StopHost crit logging.
        }
    }

    // internal (not private) so a test can drive one pass without the timer, like the sibling schedulers.
    internal async Task RunCleanupAsync(CancellationToken cancellationToken)
    {
        try
        {
            var retention = settings.UserRetention;
            if (!retention.AutoPurgeEnabled)
            {
                logger.LogDebug("Hosty disabled-user retention is turned off; skipping purge.");
                return;
            }

            var purged = await users.PurgeExpiredDisabledUsersAsync(retention.DisabledRetention, cancellationToken);
            if (purged.Count == 0)
            {
                logger.LogDebug("Hosty disabled-user retention purge found no candidates.");
                return;
            }

            await audit.AppendAsync(new AuditRecord(
                Id: $"audit_{Guid.NewGuid():N}",
                Action: "auth.user.retention.cleanup",
                ResourceType: "auth.user",
                ResourceId: null,
                Outcome: "succeeded",
                ActorUserId: null,
                CreatedAt: clock.UtcNow,
                Details: new Dictionary<string, string>
                {
                    ["retentionDays"] = retention.DisabledRetentionDays.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    ["purged"] = purged.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
                }),
                cancellationToken);
            logger.LogInformation("Hosty disabled-user retention purge deleted {PurgedCount} account(s).", purged.Count);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception ex) when (ex is AppLifecycleException or IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        {
            logger.LogWarning(ex, "Hosty disabled-user retention purge did not complete.");
        }
        catch (Exception ex)
        {
            // See AppBackupRetentionScheduler: an escaping exception would stop the host.
            logger.LogError(ex, "Hosty disabled-user retention purge failed unexpectedly; retrying next cycle.");
        }
    }
}

internal sealed record HealthResponse(string Status);

internal sealed record CoreStatusResponse(
    string Status,
    string Component,
    string Version,
    string DataRoot,
    string ListenUrl,
    int CorePort,
    string? CorePublicOrigin,
    string? ShellPublicOrigin,
    string RuntimePublicHost,
    string? ShellManifestPath,
    bool ShellAutostart,
    string IngressProvider,
    string? IngressConfigPath,
    IReadOnlyList<string> Warnings,
    DateTimeOffset ServerTime)
{
    // Core and CLI ship as one release bundle and share this version (see Directory.Build.props),
    // so reporting Core's assembly version also tells the Shell which CLI release is in play.
    private static readonly string PlatformVersion = ResolvePlatformVersion();

    // The running platform version, for callers outside status (e.g. the update-check service).
    internal static string PlatformVersionString => PlatformVersion;

    private static string ResolvePlatformVersion()
    {
        var informational = typeof(CoreStatusResponse).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (!string.IsNullOrWhiteSpace(informational))
        {
            // Strip the SourceLink "+<commit>" suffix to keep a clean semantic version.
            var plus = informational.IndexOf('+');
            return plus >= 0 ? informational[..plus] : informational;
        }

        // Format manually instead of Version.ToString(3): the latter throws when the assembly
        // version has fewer than three defined components (e.g. "1.0"), and Build is -1 when unset.
        var version = typeof(CoreStatusResponse).Assembly.GetName().Version;
        if (version is null)
        {
            return "0.0.0";
        }

        return $"{version.Major}.{version.Minor}.{(version.Build >= 0 ? version.Build : 0)}";
    }

    // Ingress provider/domain/tunnel are live operator settings, so pass the current IngressSettings
    // (from CoreSettingsService) rather than reading a startup snapshot — the reported provider and
    // warnings track settings edits without a restart. The config.yml path stays launch-only.
    // `cloudflareConnected` comes from the integration store: the API provider selected without a stored
    // connection is a legitimate intermediate state that warns rather than failing.
    public static CoreStatusResponse From(
        HostyCoreRuntimeConfig config,
        IngressSettings ingress,
        string? shellPublicOrigin,
        bool cloudflareConnected)
        => new(
            "running",
            "hosty-core",
            PlatformVersion,
            config.DataRoot,
            config.ListenUrl,
            config.CorePort,
            config.EffectiveCorePublicOrigin,
            // Resolved from Shell's app record, not Core config: null when this host has no Shell.
            shellPublicOrigin,
            config.RuntimePublicHost,
            // The Shell manifest now resolves from the distribution list at boot; only a deprecated
            // explicit legacy override still surfaces here. Null means "distribution default".
            config.Legacy?.ShellManifestPath,
            config.ShellAutostart,
            ingress.Provider,
            ingress.DerivesPublicOrigins ? config.EffectiveIngressConfigPath : null,
            [.. config.BuildPublicOriginWarnings(), .. ingress.BuildWarnings(cloudflareConnected)],
            DateTimeOffset.UtcNow);

    // Public liveness payload. `/api/core/status` is unauthenticated and, under cloudflared, published at
    // core.<domain>, so the detailed From() payload (DataRoot, manifest/ingress paths, host-path warnings)
    // must not be served to anonymous callers. Keep only status/component/version/serverTime; blank the rest.
    public static CoreStatusResponse Public()
        => new(
            "running",
            "hosty-core",
            PlatformVersion,
            DataRoot: "",
            ListenUrl: "",
            CorePort: 0,
            CorePublicOrigin: null,
            ShellPublicOrigin: null,
            RuntimePublicHost: "",
            ShellManifestPath: null,
            ShellAutostart: false,
            IngressProvider: "",
            IngressConfigPath: null,
            Warnings: [],
            ServerTime: DateTimeOffset.UtcNow);
}

internal sealed record StopResponse(string Status);

internal sealed record ErrorResponse(string Code, string Message);
