using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Microsoft.AspNetCore.HttpOverrides;

namespace Haas.Hosty.Core;

internal static class HostyCoreApplication
{
    private const string ControlSecretHeader = "X-Hosty-Control-Secret";

    public static void ConfigureServices(WebApplicationBuilder builder)
    {
        var config = HostyCoreRuntimeConfig.FromEnvironment(builder.Environment);
        builder.WebHost.UseUrls(config.ListenUrl);
        builder.Services.ConfigureHttpJsonOptions(options =>
            options.SerializerOptions.TypeInfoResolverChain.Insert(0, CoreJsonSerializerContext.Default));
        builder.Services.AddSingleton(config);
        builder.Services.AddSingleton(sp => CoreDataPaths.FromConfig(sp.GetRequiredService<HostyCoreRuntimeConfig>()));
        builder.Services.AddSingleton(new ControlSecret(CreateControlSecret()));
        builder.Services.AddSingleton<AppServiceTokenService>();
        builder.Services.AddSingleton<AppRegistryStore>();
        builder.Services.AddSingleton<UserDirectoryStore>();
        builder.Services.AddSingleton<AuthBootstrapTokenStore>();
        builder.Services.AddSingleton<AuditStore>();
        builder.Services.AddSingleton<AppAuthCodeStore>();
        builder.Services.AddSingleton<AppIdentityService>();
        builder.Services.AddSingleton<LocalPasswordAuthService>();
        builder.Services.AddSingleton<AuthBootstrapService>();
        builder.Services.AddSingleton<UserManagementService>();
        builder.Services.AddSingleton(sp => new AppManifestService(
            allowRemoteLocalCommand: sp.GetRequiredService<HostyCoreRuntimeConfig>().AllowRemoteLocalCommand));
        builder.Services.AddSingleton<AppBackupService>();
        builder.Services.AddSingleton<NotificationStore>();
        builder.Services.AddSingleton<NotificationBroadcaster>();
        builder.Services.AddSingleton<NotificationService>();
        builder.Services.AddSingleton<AppSourceService>();
        builder.Services.AddSingleton<CoreLifecycleService>();
        builder.Services.AddSingleton<LocalCommandProcessRegistry>();
        builder.Services.AddSingleton<IAppRuntimeAdapter, DockerRuntimeAdapter>();
        builder.Services.AddSingleton<IAppRuntimeAdapter, LocalCommandRuntimeAdapter>();
        builder.Services.AddSingleton<IClock, SystemClock>();
        builder.Services.AddSingleton<IIngressController>(sp =>
        {
            var ingressConfig = sp.GetRequiredService<HostyCoreRuntimeConfig>();
            return string.Equals(ingressConfig.IngressProvider, "cloudflared", StringComparison.OrdinalIgnoreCase)
                ? new CloudflaredIngressController(ingressConfig, sp.GetRequiredService<ILogger<CloudflaredIngressController>>())
                : new NoneIngressController();
        });
        builder.Services.AddHostedService<RuntimeAppSupervisorService>();
        builder.Services.AddHostedService<AppBackupRetentionScheduler>();
        builder.Services.AddHostedService<NotificationRetentionScheduler>();
        builder.Services.AddCors(options =>
        {
            options.AddPolicy("HostyShell", policy =>
            {
                policy.WithOrigins(config.EffectiveShellPublicOrigin)
                    .AllowCredentials()
                    .AllowAnyHeader()
                    .AllowAnyMethod();
            });
        });
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
        app.MapGet("/api/core/status", (HostyCoreRuntimeConfig config) => CoreJson.Json(CoreStatusResponse.From(config)));
        app.MapGet("/control/v1/core/status", (HttpRequest request, HostyCoreRuntimeConfig config, ControlSecret secret) =>
            RequireControlSecret(request, secret, () => CoreJson.Json(CoreStatusResponse.From(config))));
        app.MapPost("/control/v1/core/stop", (HttpRequest request, ControlSecret secret, IHostApplicationLifetime lifetime) =>
            RequireControlSecret(request, secret, () =>
            {
                lifetime.StopApplication();
                return CoreJson.Json(new StopResponse("stopping"));
            }));

        if (app.Environment.IsDevelopment())
        {
            app.MapGet("/login", async (HostyCoreRuntimeConfig config, UserDirectoryStore users, CancellationToken cancellationToken) =>
            {
                var state = await users.ReadAsync(cancellationToken);
                return Results.Content(RenderDevelopmentLoginPage(config, state.Users), "text/html");
            });
            app.MapPost("/login", async (
                HttpRequest request,
                HttpResponse response,
                HostyCoreRuntimeConfig config,
                UserDirectoryStore users,
                IClock clock,
                CancellationToken cancellationToken) =>
            {
                var form = await request.ReadFormAsync(cancellationToken);
                var result = await AuthEndpoints.CreateSessionAsync(
                    form["userId"].ToString(),
                    secureCookie: false,
                    response,
                    users,
                    clock,
                    cancellationToken);

                if (result.Succeeded)
                {
                    return Results.Redirect(config.EffectiveShellPublicOrigin);
                }

                var state = await users.ReadAsync(cancellationToken);
                return Results.Content(
                    RenderDevelopmentLoginPage(config, state.Users, "Select an enabled local Hosty user."),
                    "text/html",
                    Encoding.UTF8,
                    StatusCodes.Status403Forbidden);
            });
        }
        else
        {
            app.MapGet("/login", (HostyCoreRuntimeConfig config) => Results.Content(
                RenderPasswordLoginPage(config),
                "text/html"));
            app.MapPost("/login", async (
                HttpRequest request,
                HttpResponse response,
                HostyCoreRuntimeConfig config,
                LocalPasswordAuthService passwords,
                UserDirectoryStore users,
                IClock clock,
                CancellationToken cancellationToken) =>
            {
                var form = await request.ReadFormAsync(cancellationToken);
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
                        cancellationToken);

                    return result.Succeeded
                        ? Results.Redirect(config.EffectiveShellPublicOrigin)
                        : Results.Content(
                            RenderPasswordLoginPage(config, "Email or password is invalid."),
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
                        RenderPasswordLoginPage(config, message),
                        "text/html",
                        Encoding.UTF8,
                        ex.StatusCode);
                }
            });
        }
        app.MapGet("/setup", (string? setupToken, HostyCoreRuntimeConfig config) => Results.Content(
            RenderSetupPage(config, setupToken),
            "text/html"));
        app.MapGet("/setup/invite", (string? setupToken, HostyCoreRuntimeConfig config) => Results.Content(
            RenderInvitationPage(config, setupToken),
            "text/html"));
        app.MapGet("/recovery", (string? recoveryToken, HostyCoreRuntimeConfig config) => Results.Content(
            RenderRecoveryPage(config, recoveryToken),
            "text/html"));
        app.MapGet("/logout", async (
            HttpRequest request,
            HttpResponse response,
            HostyCoreRuntimeConfig config,
            UserDirectoryStore users,
            IClock clock,
            CancellationToken cancellationToken) =>
        {
            await AuthEndpoints.LogoutAsync(request, response, users, clock, cancellationToken);
            return Results.Redirect(config.EffectiveShellPublicOrigin);
        });
        app.MapGet("/api/auth/callback/oidc", (HostyCoreRuntimeConfig config) => Results.Content(RenderCorePage(
            "Hosty Core OIDC Callback",
            "Hosty Core owns external auth callbacks.",
            config), "text/html"));

        DomainEndpoints.Map(app);
        AuthEndpoints.Map(app);
        AuthBootstrapEndpoints.Map(app);
        UserManagementEndpoints.Map(app);
        LifecycleEndpoints.Map(app);
        SourceEndpoints.Map(app);
        ControlIdentityEndpoints.Map(app);
        AppDirectoryEndpoints.Map(app);
        AppBackupEndpoints.Map(app);
        NotificationEndpoints.Map(app);
    }

    internal static IResult RequireControlSecret(HttpRequest request, ControlSecret secret, Func<IResult> action)
    {
        if (!request.Headers.TryGetValue(ControlSecretHeader, out var submitted) ||
            !string.Equals(submitted.ToString(), secret.Value, StringComparison.Ordinal))
        {
            return CoreJson.Json(new ErrorResponse("control_unauthorized", "Local control secret is missing or invalid."), statusCode: StatusCodes.Status401Unauthorized);
        }

        return action();
    }

    internal static async Task<IResult> RequireControlSecret(HttpRequest request, ControlSecret secret, Func<Task<IResult>> action)
    {
        if (!request.Headers.TryGetValue(ControlSecretHeader, out var submitted) ||
            !string.Equals(submitted.ToString(), secret.Value, StringComparison.Ordinal))
        {
            return CoreJson.Json(new ErrorResponse("control_unauthorized", "Local control secret is missing or invalid."), statusCode: StatusCodes.Status401Unauthorized);
        }

        return await action();
    }

    private static string CreateControlSecret()
        => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();

    private static string RenderCorePage(string title, string message, HostyCoreRuntimeConfig config)
    {
        var encodedTitle = HtmlEncoder.Default.Encode(title);
        var encodedMessage = HtmlEncoder.Default.Encode(message);
        var encodedCoreOrigin = HtmlEncoder.Default.Encode(config.EffectiveCorePublicOrigin);
        var encodedShellOrigin = HtmlEncoder.Default.Encode(config.EffectiveShellPublicOrigin);

        return $$"""
          <!doctype html>
          <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>{{encodedTitle}}</title>
            <style>
              :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
              body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
              main { width: min(34rem, calc(100vw - 2rem)); border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 8px; padding: 1.5rem; }
              h1 { margin: 0 0 .75rem; font-size: 1.25rem; }
              p { margin: .5rem 0; line-height: 1.5; }
              code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
            </style>
          </head>
          <body>
            <main>
              <h1>{{encodedTitle}}</h1>
              <p>{{encodedMessage}}</p>
              <p>Core origin: <code>{{encodedCoreOrigin}}</code></p>
              <p>Shell origin: <code>{{encodedShellOrigin}}</code></p>
            </main>
          </body>
          </html>
          """;
    }

    private static string RenderDevelopmentLoginPage(
        HostyCoreRuntimeConfig config,
        IReadOnlyList<HostUserRecord> users,
        string? error = null)
    {
        var encodedCoreOrigin = HtmlEncoder.Default.Encode(config.EffectiveCorePublicOrigin);
        var encodedShellOrigin = HtmlEncoder.Default.Encode(config.EffectiveShellPublicOrigin);
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
                <label for="userId">Development user</label>
                <select id="userId" name="userId">{{options}}</select>
                <button type="submit">Start development session</button>
              </form>
              """;

        return $$"""
          <!doctype html>
          <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Hosty Core Login</title>
            <style>
              :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
              body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
              main { width: min(34rem, calc(100vw - 2rem)); border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 8px; padding: 1.5rem; }
              h1 { margin: 0 0 .75rem; font-size: 1.25rem; }
              p { margin: .5rem 0; line-height: 1.5; }
              form { display: grid; gap: .75rem; margin: 1rem 0; }
              label { font-weight: 650; }
              select, button { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 8px; font: inherit; padding: .7rem .85rem; }
              button { cursor: pointer; background: CanvasText; color: Canvas; }
              code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
              .error { color: #b42318; font-weight: 650; }
              .hint { color: color-mix(in srgb, CanvasText 70%, transparent); }
            </style>
          </head>
          <body>
            <main>
              <h1>Hosty Core Login</h1>
              <p>Development-only local session helper.</p>
              {{encodedError}}
              {{form}}
              <p>Core origin: <code>{{encodedCoreOrigin}}</code></p>
              <p>Shell origin: <code>{{encodedShellOrigin}}</code></p>
              <p class="hint">Production authentication remains owned by Core auth providers.</p>
            </main>
          </body>
          </html>
          """;
    }

    private static string RenderPasswordLoginPage(HostyCoreRuntimeConfig config, string? error = null)
    {
        var encodedCoreOrigin = HtmlEncoder.Default.Encode(config.EffectiveCorePublicOrigin);
        var encodedShellOrigin = HtmlEncoder.Default.Encode(config.EffectiveShellPublicOrigin);
        var encodedError = error is null
            ? string.Empty
            : $"""<p class="error">{HtmlEncoder.Default.Encode(error)}</p>""";

        return $$"""
          <!doctype html>
          <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Hosty Core Login</title>
            <style>
              :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
              body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
              main { width: min(34rem, calc(100vw - 2rem)); border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 8px; padding: 1.5rem; }
              h1 { margin: 0 0 .75rem; font-size: 1.25rem; }
              p { margin: .5rem 0; line-height: 1.5; }
              form { display: grid; gap: .75rem; margin: 1rem 0; }
              label { font-weight: 650; }
              input, button { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 8px; font: inherit; padding: .7rem .85rem; }
              button { cursor: pointer; background: CanvasText; color: Canvas; }
              code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
              .error { color: #b42318; font-weight: 650; }
              .hint { color: color-mix(in srgb, CanvasText 70%, transparent); }
            </style>
          </head>
          <body>
            <main>
              <h1>Hosty Core Login</h1>
              {{encodedError}}
              <form method="post" action="/login">
                <label for="email">Email</label>
                <input id="email" name="email" type="email" autocomplete="email" required>
                <label for="password">Password</label>
                <input id="password" name="password" type="password" autocomplete="current-password" required>
                <button type="submit">Sign in</button>
              </form>
              <p>Core origin: <code>{{encodedCoreOrigin}}</code></p>
              <p>Shell origin: <code>{{encodedShellOrigin}}</code></p>
              <p class="hint">Use recovery from the local CLI if this account does not have a password yet.</p>
            </main>
          </body>
          </html>
          """;
    }

    private static string RenderSetupPage(HostyCoreRuntimeConfig config, string? setupToken)
    {
        var encodedToken = HtmlEncoder.Default.Encode(setupToken ?? "");
        var encodedShellOrigin = JavaScriptEncoder.Default.Encode(config.EffectiveShellPublicOrigin);

        return $$"""
          <!doctype html>
          <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Hosty Core Setup</title>
            <style>
              :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
              body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
              main { width: min(34rem, calc(100vw - 2rem)); border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 8px; padding: 1.5rem; }
              h1 { margin: 0 0 .75rem; font-size: 1.25rem; }
              p { margin: .5rem 0; line-height: 1.5; }
              form { display: grid; gap: .75rem; margin-top: 1rem; }
              label { font-weight: 650; }
              input, button { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 8px; font: inherit; padding: .7rem .85rem; }
              button { cursor: pointer; background: CanvasText; color: Canvas; }
              .error { color: #b42318; font-weight: 650; }
            </style>
          </head>
          <body>
            <main>
              <h1>Hosty Core Setup</h1>
              <p id="message"></p>
              <form id="setup-form">
                <input type="hidden" id="setup-token" value="{{encodedToken}}">
                <label for="email">Email</label>
                <input id="email" name="email" type="email" autocomplete="email" required>
                <label for="display-name">Display name</label>
                <input id="display-name" name="displayName" autocomplete="name">
                <label for="password">Password</label>
                <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8">
                <label for="confirm-password">Confirm password</label>
                <input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" required minlength="8">
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
                window.location.href = '{{encodedShellOrigin}}';
              });
            </script>
          </body>
          </html>
          """;
    }

    private static string RenderRecoveryPage(HostyCoreRuntimeConfig config, string? recoveryToken)
    {
        var encodedToken = HtmlEncoder.Default.Encode(recoveryToken ?? "");
        var encodedShellOrigin = JavaScriptEncoder.Default.Encode(config.EffectiveShellPublicOrigin);

        return $$"""
          <!doctype html>
          <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Hosty Core Recovery</title>
            <style>
              :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
              body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
              main { width: min(34rem, calc(100vw - 2rem)); border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 8px; padding: 1.5rem; }
              h1 { margin: 0 0 .75rem; font-size: 1.25rem; }
              p { margin: .5rem 0; line-height: 1.5; }
              form { display: grid; gap: .75rem; margin-top: 1rem; }
              label { font-weight: 650; }
              input, button { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 8px; font: inherit; padding: .7rem .85rem; }
              button { cursor: pointer; background: CanvasText; color: Canvas; }
              .error { color: #b42318; font-weight: 650; }
            </style>
          </head>
          <body>
            <main>
              <h1>Hosty Core Recovery</h1>
              <p id="message"></p>
              <form id="recovery-form">
                <input type="hidden" id="recovery-token" value="{{encodedToken}}">
                <label for="email">Email</label>
                <input id="email" name="email" type="email" autocomplete="email" required>
                <label for="display-name">Display name</label>
                <input id="display-name" name="displayName" autocomplete="name">
                <label for="password">Password</label>
                <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8">
                <label for="confirm-password">Confirm password</label>
                <input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" required minlength="8">
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
                window.location.href = '{{encodedShellOrigin}}';
              });
            </script>
          </body>
          </html>
          """;
    }

    private static string RenderInvitationPage(HostyCoreRuntimeConfig config, string? setupToken)
    {
        var encodedToken = HtmlEncoder.Default.Encode(setupToken ?? "");
        var encodedShellOrigin = JavaScriptEncoder.Default.Encode(config.EffectiveShellPublicOrigin);

        return $$"""
          <!doctype html>
          <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Hosty Core Invitation</title>
            <style>
              :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
              body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
              main { width: min(34rem, calc(100vw - 2rem)); border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 8px; padding: 1.5rem; }
              h1 { margin: 0 0 .75rem; font-size: 1.25rem; }
              p { margin: .5rem 0; line-height: 1.5; }
              form { display: grid; gap: .75rem; margin-top: 1rem; }
              label { font-weight: 650; }
              input, button { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 8px; font: inherit; padding: .7rem .85rem; }
              button { cursor: pointer; background: CanvasText; color: Canvas; }
              .error { color: #b42318; font-weight: 650; }
            </style>
          </head>
          <body>
            <main>
              <h1>Hosty Core Invitation</h1>
              <p>Core owns invitation acceptance and session creation.</p>
              <p id="message"></p>
              <form id="invite-form">
                <input type="hidden" id="setup-token" value="{{encodedToken}}">
                <label for="display-name">Display name</label>
                <input id="display-name" name="displayName" autocomplete="name">
                <label for="password">Password</label>
                <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8">
                <label for="confirm-password">Confirm password</label>
                <input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" required minlength="8">
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
                window.location.href = '{{encodedShellOrigin}}';
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
    int ShellPort,
    string ListenUrl,
    string? CorePublicOrigin,
    string? ShellPublicOrigin,
    string RuntimePublicHost,
    string? ShellManifestPath,
    string ShellBootstrapRuntime,
    string? ShellSourceOverridePath,
    bool ShellBootstrapEnabled,
    bool ShellAutostart,
    string? TrustedProxySecret = null,
    bool AllowRemoteLocalCommand = false,
    string IngressProvider = "none",
    string? IngressBaseDomain = null,
    string? IngressConfigPath = null,
    string? IngressTunnelId = null,
    string? IngressCredentialsFile = null)
{
    public string EffectiveCorePublicOrigin => CorePublicOrigin ?? ListenUrl;

    public string EffectiveShellPublicOrigin => ShellPublicOrigin ?? $"http://localhost:{ShellPort.ToString(System.Globalization.CultureInfo.InvariantCulture)}";

    public string EffectiveIngressConfigPath => IngressConfigPath ?? Path.Combine(DataRoot, "core", "ingress", "config.yml");

    public static HostyCoreRuntimeConfig FromEnvironment(IHostEnvironment environment)
    {
        var dataRoot = NormalizePath(
            ReadFirst("HOSTY_DATA_ROOT", "HOSTY_HOME") ??
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".hosty"));
        var coreRoot = Path.Combine(dataRoot, "core");
        var runDirectory = Path.Combine(coreRoot, "run");
        var corePort = ReadPort("HOSTY_CORE_PORT", 7070);
        var shellPort = ReadPort("HOSTY_SHELL_PORT", 7171);
        var listenUrl = NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_CORE_URL")) ??
            NormalizeOptional(Environment.GetEnvironmentVariable("ASPNETCORE_URLS")) ??
            $"http://localhost:{corePort}";
        var corePublicOrigin = NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_CORE_PUBLIC_ORIGIN"));
        var shellPublicOrigin = NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_SHELL_PUBLIC_ORIGIN"));
        var runtimePublicHost = "localhost";
        var shellManifestPath = NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_SHELL_MANIFEST_PATH")) ??
            ResolveDefaultShellManifestPath();
        // Resolve to absolute paths: the credentials path is written verbatim into config.yml and
        // cloudflared (run from another cwd / as a service) cannot resolve relative or ~ paths.
        var ingressConfigPath = NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_INGRESS_CONFIG_PATH")) is { } configPath
            ? NormalizePath(configPath)
            : null;
        var ingressCredentialsFile = NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_INGRESS_CREDENTIALS_FILE")) is { } credentialsPath
            ? NormalizePath(credentialsPath)
            : null;

        return new HostyCoreRuntimeConfig(
            dataRoot,
            runDirectory,
            Path.Combine(runDirectory, "control.json"),
            corePort,
            shellPort,
            listenUrl,
            corePublicOrigin,
            shellPublicOrigin,
            runtimePublicHost,
            shellManifestPath,
            NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_SHELL_BOOTSTRAP_RUNTIME")) ?? "docker",
            NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_SHELL_SOURCE_OVERRIDE_PATH")),
            ReadBoolean("HOSTY_SHELL_BOOTSTRAP_ENABLED", defaultValue: true),
            ReadBoolean("HOSTY_SHELL_AUTOSTART", defaultValue: true),
            NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_TRUSTED_PROXY_SECRET")),
            ReadBoolean("HOSTY_ALLOW_REMOTE_LOCAL_COMMAND", defaultValue: false),
            NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_INGRESS_PROVIDER")) ?? "none",
            NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_INGRESS_BASE_DOMAIN")),
            ingressConfigPath,
            NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_INGRESS_TUNNEL_ID")),
            ingressCredentialsFile);
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

    public IReadOnlyList<string> BuildPublicOriginWarnings()
    {
        var warnings = new List<string>();
        AddPublicOriginWarnings(warnings, "Core", CorePublicOrigin);
        AddPublicOriginWarnings(warnings, "Shell", ShellPublicOrigin);
        return warnings;
    }

    public IReadOnlyList<string> BuildIngressWarnings()
    {
        if (!string.Equals(IngressProvider, "cloudflared", StringComparison.OrdinalIgnoreCase))
        {
            return [];
        }

        var warnings = new List<string>();
        if (string.IsNullOrWhiteSpace(IngressBaseDomain))
        {
            warnings.Add("Ingress provider 'cloudflared' requires HOSTY_INGRESS_BASE_DOMAIN; tunnel config will not be written.");
        }
        else if (!CloudflaredIngressPlanner.IsValidHostname(IngressBaseDomain))
        {
            warnings.Add($"HOSTY_INGRESS_BASE_DOMAIN '{IngressBaseDomain}' is not a valid lowercase domain; ingress hostnames will be skipped.");
        }

        if (string.IsNullOrWhiteSpace(IngressTunnelId))
        {
            warnings.Add("Ingress provider 'cloudflared' requires HOSTY_INGRESS_TUNNEL_ID; tunnel config will not be written.");
        }

        if (string.IsNullOrWhiteSpace(IngressCredentialsFile))
        {
            warnings.Add("Ingress provider 'cloudflared' requires HOSTY_INGRESS_CREDENTIALS_FILE; tunnel config will not be written.");
        }

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

    private static string? ResolveDefaultShellManifestPath()
    {
        foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
        {
            var directory = new DirectoryInfo(start);
            while (directory is not null)
            {
                var candidate = Path.Combine(directory.FullName, "apps", "shell", "manifest.json");
                if (File.Exists(candidate))
                {
                    return candidate;
                }

                candidate = Path.Combine(directory.FullName, "shell", "manifest.json");
                if (File.Exists(candidate))
                {
                    return candidate;
                }

                directory = directory.Parent;
            }
        }

        return null;
    }
}

internal sealed class RuntimeAppSupervisorService(
    HostyCoreRuntimeConfig config,
    AppRegistryStore apps,
    CoreLifecycleService lifecycle,
    AppSourceService sources,
    ILogger<RuntimeAppSupervisorService> logger) : BackgroundService
{
    private const string ShellAppId = "hosty.shell";
    private static readonly TimeSpan RuntimeAppShutdownTimeout = TimeSpan.FromSeconds(15);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Yield();

        await EnsureShellInstalledAsync(stoppingToken);
        await StopAutostartDisabledAppsAsync(stoppingToken);
        await StartAutostartAppsAsync(stoppingToken);
        await lifecycle.ReconcileIngressAsync(stoppingToken);

        try
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);
        await StopRuntimeAppsAsync(cancellationToken);
    }

    private async Task EnsureShellInstalledAsync(CancellationToken cancellationToken)
    {
        if (!config.ShellBootstrapEnabled)
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(config.ShellManifestPath))
        {
            logger.LogWarning("Hosty Shell bootstrap skipped because no Shell manifest path or URL was configured.");
            return;
        }

        try
        {
            var shell = await apps.GetAppAsync(ShellAppId, cancellationToken);
            if (shell is null)
            {
                await lifecycle.InstallAsync(new AppInstallRequest(
                    ManifestPath: config.ShellManifestPath,
                    SelectedRuntime: config.ShellBootstrapRuntime,
                    System: true,
                    Settings: BuildShellBootstrapSettings(config),
                    Autostart: config.ShellAutostart), cancellationToken);
                shell = await apps.GetAppAsync(ShellAppId, cancellationToken);
            }
            else
            {
                shell = await ReconcileShellManifestAsync(shell, cancellationToken);
            }

            var bootstrapSettings = BuildShellBootstrapSettings(config);
            if (shell is not null && bootstrapSettings.Count > 0)
            {
                await lifecycle.ConfigureAsync(ShellAppId, new AppConfigureRequest(bootstrapSettings), cancellationToken);
            }

            if (shell is not null && shell.Autostart != config.ShellAutostart)
            {
                await lifecycle.ConfigureAutostartAsync(ShellAppId, new AppAutostartRequest(config.ShellAutostart), cancellationToken);
            }

            if (shell is not null && !string.IsNullOrWhiteSpace(config.ShellSourceOverridePath))
            {
                await sources.SetLocalOverrideAsync(
                    ShellAppId,
                    new AppSourceOverrideRequest(config.ShellSourceOverridePath),
                    cancellationToken);
            }
        }
        catch (Exception ex) when (!cancellationToken.IsCancellationRequested &&
            ex is AppLifecycleException or AppManifestException or HttpRequestException or TaskCanceledException or IOException or UnauthorizedAccessException)
        {
            logger.LogWarning(ex, "Hosty Shell bootstrap did not complete; Core remains available through CLI and control APIs.");
        }
    }

    private async Task<AppRecord?> ReconcileShellManifestAsync(AppRecord shell, CancellationToken cancellationToken)
    {
        if (!string.Equals(shell.SelectedRuntime ?? config.ShellBootstrapRuntime, config.ShellBootstrapRuntime, StringComparison.Ordinal))
        {
            logger.LogInformation(
                "Hosty Shell bootstrap reconciliation skipped because installed runtime {InstalledRuntime} differs from configured runtime {ConfiguredRuntime}.",
                shell.SelectedRuntime,
                config.ShellBootstrapRuntime);
            return shell;
        }

        var plan = await lifecycle.CreateUpdatePlanAsync(
            ShellAppId,
            new AppUpdatePlanRequest(config.ShellManifestPath, config.ShellBootstrapRuntime),
            cancellationToken);

        var configuredManifestReferenceChanged = HasShellManifestReferenceChanged(shell);
        if (plan.Changes.Count == 0 && !configuredManifestReferenceChanged)
        {
            return shell;
        }

        logger.LogInformation(
            "Hosty Shell bootstrap applying manifest reconciliation with {ChangeCount} reported changes.",
            plan.Changes.Count);
        await lifecycle.ApplyUpdateAsync(
            ShellAppId,
            new AppUpdateApplyRequest(
                PlanDigest: plan.PlanDigest,
                ManifestPath: config.ShellManifestPath,
                SelectedRuntime: config.ShellBootstrapRuntime),
            cancellationToken);
        return await apps.GetAppAsync(ShellAppId, cancellationToken);
    }

    private static bool IsHttpManifestReference(string? manifestPath)
        => Uri.TryCreate(manifestPath, UriKind.Absolute, out var uri) &&
            (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

    private bool HasShellManifestReferenceChanged(AppRecord shell)
    {
        if (IsHttpManifestReference(config.ShellManifestPath))
        {
            return !string.Equals(shell.ManifestUrl, config.ShellManifestPath, StringComparison.Ordinal);
        }

        return !string.IsNullOrWhiteSpace(shell.ManifestUrl);
    }

    private static IReadOnlyDictionary<string, string?> BuildShellBootstrapSettings(HostyCoreRuntimeConfig config)
    {
        var shellPort = config.ShellPort.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var settings = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["HOSTY_PORT_HTTP"] = shellPort,
        };

        if (Uri.TryCreate(config.EffectiveShellPublicOrigin, UriKind.Absolute, out var shellOrigin))
        {
            if (!string.IsNullOrWhiteSpace(shellOrigin.Host))
            {
                settings["HOSTNAME"] = shellOrigin.Host;
            }
        }

        return settings;
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

    private async Task StopRuntimeAppsAsync(CancellationToken cancellationToken)
    {
        // Bound the per-shutdown app stop so a wedged app can never hold the process
        // (and therefore the listening port) open indefinitely. When the bound is hit
        // we abandon the remaining stops and let shutdown continue so the port frees.
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(RuntimeAppShutdownTimeout);
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
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(
                "Hosty runtime app shutdown stop exceeded {Timeout} and was abandoned so Core can release its port.",
                RuntimeAppShutdownTimeout);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
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
                SchemaVersion: 1,
                Component: "hosty-core",
                Transport: "http-loopback",
                Endpoint: config.ListenUrl,
                ControlBaseUrl: $"{config.ListenUrl.TrimEnd('/')}/control/v1",
                RequiredHeaders: new Dictionary<string, string>
                {
                    ["X-Hosty-Control-Secret"] = secret.Value,
                },
                StartedAt: DateTimeOffset.UtcNow);

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
            if (File.Exists(config.ControlDiscoveryPath))
            {
                File.Delete(config.ControlDiscoveryPath);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning(ex, "Unable to remove Hosty Core control discovery at {Path}", config.ControlDiscoveryPath);
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
    DateTimeOffset StartedAt);

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

    private async Task RunCleanupAsync(CancellationToken cancellationToken)
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
    int ShellPort,
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

    public static CoreStatusResponse From(HostyCoreRuntimeConfig config)
        => new(
            "running",
            "hosty-core",
            PlatformVersion,
            config.DataRoot,
            config.ListenUrl,
            config.CorePort,
            config.ShellPort,
            config.EffectiveCorePublicOrigin,
            config.EffectiveShellPublicOrigin,
            config.RuntimePublicHost,
            config.ShellManifestPath,
            config.ShellAutostart,
            config.IngressProvider,
            string.Equals(config.IngressProvider, "cloudflared", StringComparison.OrdinalIgnoreCase)
                ? config.EffectiveIngressConfigPath
                : null,
            [.. config.BuildPublicOriginWarnings(), .. config.BuildIngressWarnings()],
            DateTimeOffset.UtcNow);
}

internal sealed record StopResponse(string Status);

internal sealed record ErrorResponse(string Code, string Message);
