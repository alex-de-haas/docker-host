using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.AspNetCore.HttpOverrides;

namespace Haas.Hosty.Core;

internal static class HostyCoreApplication
{
    private const string ControlSecretHeader = "X-Hosty-Control-Secret";

    public static void ConfigureServices(WebApplicationBuilder builder)
    {
        var config = HostyCoreRuntimeConfig.FromEnvironment(builder.Environment);
        builder.WebHost.UseUrls(config.ListenUrl);
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
        builder.Services.AddSingleton<AuthBootstrapService>();
        builder.Services.AddSingleton<UserManagementService>();
        builder.Services.AddSingleton(_ => new AppManifestService());
        builder.Services.AddSingleton<AppBackupService>();
        builder.Services.AddSingleton<AppSourceService>();
        builder.Services.AddSingleton<CoreLifecycleService>();
        builder.Services.AddSingleton<LocalCommandProcessRegistry>();
        builder.Services.AddSingleton<IAppRuntimeAdapter, DockerRuntimeAdapter>();
        builder.Services.AddSingleton<IAppRuntimeAdapter, LocalCommandRuntimeAdapter>();
        builder.Services.AddSingleton<IClock, SystemClock>();
        builder.Services.AddHostedService<RuntimeAppSupervisorService>();
        builder.Services.AddHostedService<AppBackupRetentionScheduler>();
        builder.Services.AddCors(options =>
        {
            options.AddPolicy("HostyShell", policy =>
            {
                if (!string.IsNullOrWhiteSpace(config.ShellPublicOrigin))
                {
                    policy.WithOrigins(config.ShellPublicOrigin)
                        .AllowCredentials()
                        .AllowAnyHeader()
                        .AllowAnyMethod();
                }
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

        app.MapGet("/healthz", () => Results.Json(new HealthResponse("ok")));
        app.MapGet("/api/core/status", (HostyCoreRuntimeConfig config) => Results.Json(CoreStatusResponse.From(config)));
        app.MapGet("/control/v1/core/status", (HttpRequest request, HostyCoreRuntimeConfig config, ControlSecret secret) =>
            RequireControlSecret(request, secret, () => Results.Json(CoreStatusResponse.From(config))));
        app.MapPost("/control/v1/core/stop", (HttpRequest request, ControlSecret secret, IHostApplicationLifetime lifetime) =>
            RequireControlSecret(request, secret, () =>
            {
                lifetime.StopApplication();
                return Results.Json(new StopResponse("stopping"));
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
                    return Results.Redirect(config.ShellPublicOrigin ?? "/");
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
            app.MapGet("/login", (HostyCoreRuntimeConfig config) => Results.Content(RenderCorePage(
                "Hosty Core Login",
                "Hosty Core owns login and session setup in the final architecture.",
                config), "text/html"));
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
            return Results.Redirect(config.ShellPublicOrigin ?? "/login");
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
    }

    internal static IResult RequireControlSecret(HttpRequest request, ControlSecret secret, Func<IResult> action)
    {
        if (!request.Headers.TryGetValue(ControlSecretHeader, out var submitted) ||
            !string.Equals(submitted.ToString(), secret.Value, StringComparison.Ordinal))
        {
            return Results.Json(new ErrorResponse("control_unauthorized", "Local control secret is missing or invalid."), statusCode: StatusCodes.Status401Unauthorized);
        }

        return action();
    }

    internal static async Task<IResult> RequireControlSecret(HttpRequest request, ControlSecret secret, Func<Task<IResult>> action)
    {
        if (!request.Headers.TryGetValue(ControlSecretHeader, out var submitted) ||
            !string.Equals(submitted.ToString(), secret.Value, StringComparison.Ordinal))
        {
            return Results.Json(new ErrorResponse("control_unauthorized", "Local control secret is missing or invalid."), statusCode: StatusCodes.Status401Unauthorized);
        }

        return await action();
    }

    private static string CreateControlSecret()
        => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();

    private static string RenderCorePage(string title, string message, HostyCoreRuntimeConfig config)
    {
        var encodedTitle = HtmlEncoder.Default.Encode(title);
        var encodedMessage = HtmlEncoder.Default.Encode(message);
        var encodedCoreOrigin = HtmlEncoder.Default.Encode(config.CorePublicOrigin ?? config.ListenUrl);
        var encodedShellOrigin = HtmlEncoder.Default.Encode(config.ShellPublicOrigin ?? "not configured");

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
        var encodedCoreOrigin = HtmlEncoder.Default.Encode(config.CorePublicOrigin ?? config.ListenUrl);
        var encodedShellOrigin = HtmlEncoder.Default.Encode(config.ShellPublicOrigin ?? "not configured");
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

    private static string RenderSetupPage(HostyCoreRuntimeConfig config, string? setupToken)
    {
        var encodedToken = HtmlEncoder.Default.Encode(setupToken ?? "");
        var encodedShellOrigin = JavaScriptEncoder.Default.Encode(config.ShellPublicOrigin ?? "/");

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
                const response = await fetch('/api/auth/bootstrap', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    setupToken: document.getElementById('setup-token').value,
                    email: document.getElementById('email').value,
                    displayName: document.getElementById('display-name').value || undefined
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
        var encodedShellOrigin = JavaScriptEncoder.Default.Encode(config.ShellPublicOrigin ?? "/");

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
                const response = await fetch('/api/auth/recovery', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    recoveryToken: document.getElementById('recovery-token').value,
                    email: document.getElementById('email').value,
                    displayName: document.getElementById('display-name').value || undefined
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
        var encodedShellOrigin = JavaScriptEncoder.Default.Encode(config.ShellPublicOrigin ?? "/");

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
                const response = await fetch('/api/auth/invitations/accept', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    setupToken: document.getElementById('setup-token').value,
                    displayName: document.getElementById('display-name').value || undefined
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
    string ListenUrl,
    string? CorePublicOrigin,
    string? ShellPublicOrigin,
    string RuntimePublicHost,
    string? ShellManifestPath,
    bool ShellBootstrapEnabled,
    bool ShellAutostart)
{
    private const string DefaultDevelopmentShellPublicOrigin = "http://127.0.0.1:3000";

    public static HostyCoreRuntimeConfig FromEnvironment(IHostEnvironment environment)
    {
        var dataRoot = NormalizePath(
            ReadFirst("HOSTY_CORE_DATA_ROOT", "HOST_DATA_ROOT_HOST", "HOSTY_HOME") ??
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".hosty"));
        var coreRoot = Path.Combine(dataRoot, "core");
        var runDirectory = Path.Combine(coreRoot, "run");
        var listenUrl = NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_CORE_URL")) ??
            NormalizeOptional(Environment.GetEnvironmentVariable("ASPNETCORE_URLS")) ??
            "http://127.0.0.1:3001";
        var combinedPublicOrigin = NormalizeOptional(Environment.GetEnvironmentVariable("HOST_PUBLIC_ORIGIN"));
        var corePublicOrigin = NormalizeOptional(Environment.GetEnvironmentVariable("HOST_CORE_PUBLIC_ORIGIN")) ??
            combinedPublicOrigin;
        var shellPublicOrigin = NormalizeOptional(Environment.GetEnvironmentVariable("HOST_SHELL_PUBLIC_ORIGIN")) ??
            combinedPublicOrigin ??
            ResolveDefaultShellPublicOrigin(environment);
        var runtimePublicHost = NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_RUNTIME_PUBLIC_HOST")) ??
            "app.localhost";
        var shellManifestPath = NormalizeOptional(Environment.GetEnvironmentVariable("HOSTY_SHELL_MANIFEST_PATH")) ??
            ResolveDefaultShellManifestPath();

        return new HostyCoreRuntimeConfig(
            dataRoot,
            runDirectory,
            Path.Combine(runDirectory, "control.json"),
            listenUrl,
            corePublicOrigin,
            shellPublicOrigin,
            runtimePublicHost,
            shellManifestPath,
            ReadBoolean("HOSTY_SHELL_BOOTSTRAP_ENABLED", defaultValue: true),
            ReadBoolean("HOSTY_SHELL_AUTOSTART", defaultValue: true));
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

    private static string? ResolveDefaultShellPublicOrigin(IHostEnvironment environment)
        => environment.IsDevelopment() ? DefaultDevelopmentShellPublicOrigin : null;

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
    ILogger<RuntimeAppSupervisorService> logger) : BackgroundService
{
    private const string ShellAppId = "hosty.shell";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Yield();

        await EnsureShellInstalledAsync(stoppingToken);
        await StopAutostartDisabledAppsAsync(stoppingToken);
        await StartAutostartAppsAsync(stoppingToken);

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

        if (string.IsNullOrWhiteSpace(config.ShellManifestPath) || !File.Exists(config.ShellManifestPath))
        {
            logger.LogWarning("Hosty Shell bootstrap skipped because the Shell manifest was not found.");
            return;
        }

        try
        {
            var shell = await apps.GetAppAsync(ShellAppId, cancellationToken);
            if (shell is null)
            {
                await lifecycle.InstallAsync(new AppInstallRequest(
                    ManifestPath: config.ShellManifestPath,
                    SelectedRuntime: "docker",
                    SelectedChannel: "local",
                    System: true,
                    Autostart: config.ShellAutostart), cancellationToken);
                shell = await apps.GetAppAsync(ShellAppId, cancellationToken);
            }

            if (shell is not null && shell.Autostart != config.ShellAutostart)
            {
                await lifecycle.ConfigureAutostartAsync(ShellAppId, new AppAutostartRequest(config.ShellAutostart), cancellationToken);
            }
        }
        catch (Exception ex) when (ex is AppLifecycleException or AppManifestException or IOException or UnauthorizedAccessException)
        {
            logger.LogWarning(ex, "Hosty Shell bootstrap did not complete; Core remains available through CLI and control APIs.");
        }
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
        try
        {
            var results = await lifecycle.StopRuntimeAppsAsync(cancellationToken);
            foreach (var result in results.Where(result => !result.Succeeded))
            {
                logger.LogWarning(
                    "Hosty shutdown stop failed for runtime app {AppId}: {ErrorCode} {Message}",
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
            logger.LogWarning(ex, "Hosty runtime app shutdown stop did not complete.");
        }
    }
}

internal sealed class ControlDiscoveryWriter(
    HostyCoreRuntimeConfig config,
    ControlSecret secret,
    ILogger<ControlDiscoveryWriter> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(config.RunDirectory);
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

        var json = JsonSerializer.Serialize(discovery, JsonOptions);
        await File.WriteAllTextAsync(config.ControlDiscoveryPath, json, cancellationToken);
        logger.LogInformation("Hosty Core control discovery written to {Path}", config.ControlDiscoveryPath);
    }

    public Task StopAsync(CancellationToken cancellationToken)
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

        return Task.CompletedTask;
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
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
        await RunCleanupAsync(stoppingToken);

        using var timer = new PeriodicTimer(CleanupInterval);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            await RunCleanupAsync(stoppingToken);
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
    string DataRoot,
    string ListenUrl,
    string? CorePublicOrigin,
    string? ShellPublicOrigin,
    string RuntimePublicHost,
    string? ShellManifestPath,
    bool ShellAutostart,
    IReadOnlyList<string> Warnings,
    DateTimeOffset ServerTime)
{
    public static CoreStatusResponse From(HostyCoreRuntimeConfig config)
        => new(
            "running",
            "hosty-core",
            config.DataRoot,
            config.ListenUrl,
            config.CorePublicOrigin,
            config.ShellPublicOrigin,
            config.RuntimePublicHost,
            config.ShellManifestPath,
            config.ShellAutostart,
            config.BuildPublicOriginWarnings(),
            DateTimeOffset.UtcNow);
}

internal sealed record StopResponse(string Status);

internal sealed record ErrorResponse(string Code, string Message);
