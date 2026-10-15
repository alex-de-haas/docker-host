using System.Net;
using System.Text;
using System.Text.Json;

namespace Haas.Hosty.Core;

// The parent owns transport to a selected child, never credentials to the main Core. Setup invokes
// the ordinary password bootstrap and login contracts; the resulting child cookie stays private.
internal sealed class CoreEnvironmentAccess(CoreEnvironmentStore store, CoreEnvironmentService service)
{
    private static HttpClient Client() => new(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
        { Timeout = TimeSpan.FromMinutes(3) };
    private static Uri Origin(CoreEnvironmentRecord record) => new($"http://localhost:{record.Port}");
    private string SessionPath(string id) => Path.Combine(store.Root(id), "core", "parent-session.json");
    public async Task<CoreEnvironmentApiResponse> SetupAsync(SandboxActor actor, string id, CoreEnvironmentSetup input, CancellationToken ct)
    {
        using var stopping = CancellationTokenSource.CreateLinkedTokenSource(ct, service.Stopping);
        ct = stopping.Token;
        var gate = service.Gate(id); await gate.WaitAsync(ct);
        try
        {
            var record = await service.RequireAsync(actor, id, ct); RequireRunning(record); store.VerifyRoot(record);
            using var client = Client();
            var discovery = await JsonStorage.ReadAsync<ControlDiscoveryDocument>(Path.Combine(store.Root(id), "core", "run", "control.json"), ct)
                ?? throw new SandboxException("environment_not_ready", "Child Core control discovery is unavailable.", 409);
            if (!Uri.TryCreate(discovery.ControlBaseUrl, UriKind.Absolute, out var control) || !control.IsLoopback || control.Scheme != "http")
                throw new SandboxException("environment_control_invalid", "Child control discovery is invalid.", 409);
            using var setup = new HttpRequestMessage(HttpMethod.Post, discovery.ControlBaseUrl.TrimEnd('/') + "/auth/setup-token");
            foreach (var header in discovery.RequiredHeaders) setup.Headers.TryAddWithoutValidation(header.Key, header.Value);
            using var tokenResponse = await client.SendAsync(setup, ct);
            if (tokenResponse.IsSuccessStatusCode)
            {
                using var token = JsonDocument.Parse(await tokenResponse.Content.ReadAsStringAsync(ct));
                using var bootstrap = new HttpRequestMessage(HttpMethod.Post, new Uri(Origin(record), "/api/auth/bootstrap"))
                { Content = new StringContent(CoreJson.Text(new AuthBootstrapRequest(token.RootElement.GetProperty("token").GetString()!, input.Email, input.DisplayName, input.Password)), Encoding.UTF8, "application/json") };
                using var result = await client.SendAsync(bootstrap, ct);
                if (!result.IsSuccessStatusCode) return await ResultAsync(result, ct);
            }
            // Repeated setup on an initialized root performs a normal password login; it cannot
            // replace the existing administrator or reset credentials through the parent API.
            using var login = new HttpRequestMessage(HttpMethod.Post, new Uri(Origin(record), "/login"))
            { Content = new FormUrlEncodedContent(new Dictionary<string, string> { ["email"] = input.Email, ["password"] = input.Password }) };
            using var loggedIn = await client.SendAsync(login, ct);
            var cookie = loggedIn.Headers.TryGetValues("Set-Cookie", out var cookies)
                ? cookies.Select(c => c.Split(';')[0]).FirstOrDefault(c => c.StartsWith("hosty_session=", StringComparison.Ordinal)) : null;
            if (cookie is null) throw new SandboxException("environment_login_failed", "Child Core password login failed.", 401);
            using var csrfResponse = await client.GetAsync(new Uri(Origin(record), "/api/auth/csrf"), ct);
            var csrfCookie = csrfResponse.Headers.GetValues("Set-Cookie").Select(c => c.Split(';')[0]).First(c => c.StartsWith("hosty_csrf=", StringComparison.Ordinal));
            await JsonStorage.WriteAsync(SessionPath(id), new CoreEnvironmentSession(cookie + "; " + csrfCookie, csrfCookie["hosty_csrf=".Length..]), true, ct);
            using var ready = JsonDocument.Parse("{\"ready\":true}");
            return new(200, ready.RootElement.Clone());
        }
        finally { gate.Release(); }
    }
    public async Task<CoreEnvironmentApiResponse> SendAsync(SandboxActor actor, string id, CoreEnvironmentApiRequest input, CancellationToken ct)
    {
        using var stopping = CancellationTokenSource.CreateLinkedTokenSource(ct, service.Stopping);
        ct = stopping.Token;
        var gate = service.Gate(id); await gate.WaitAsync(ct);
        try
        {
            var record = await service.RequireAsync(actor, id, ct); RequireRunning(record); store.VerifyRoot(record);
            if (input.Method is not ("GET" or "POST" or "PUT" or "DELETE" or "PATCH") || !input.Path.StartsWith("/api/", StringComparison.Ordinal)
                || input.Path.Contains('\\') || input.Path.Contains('#') || input.Path.Any(char.IsControl))
                throw new SandboxException("environment_api_invalid", "Use a relative /api/ path and a JSON HTTP method.", 400);
            var origin = Origin(record); var uri = new Uri(origin, input.Path);
            if (uri.Authority != origin.Authority || !uri.AbsolutePath.StartsWith("/api/", StringComparison.Ordinal)
                || uri.AbsolutePath is "/api/mcp" or "/api/events")
                throw new SandboxException("environment_api_invalid", "Only bounded JSON requests to the selected child Core are supported.", 400);
            var session = await JsonStorage.ReadAsync<CoreEnvironmentSession>(SessionPath(id), ct)
                ?? throw new SandboxException("environment_setup_required", "Complete normal child Core setup/password login first.", 409);
            using var client = Client();
            using var request = new HttpRequestMessage(new HttpMethod(input.Method), uri);
            request.Headers.Add("Cookie", session.Cookie); request.Headers.Add("X-Hosty-CSRF", session.Csrf);
            request.Headers.Add("Origin", origin.ToString().TrimEnd('/'));
            if (input.Body is { } body) request.Content = new StringContent(body.GetRawText(), Encoding.UTF8, "application/json");
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            return await ResultAsync(response, ct);
        }
        finally { gate.Release(); }
    }
    public async Task<CoreEnvironmentApplications> ApplicationsAsync(SandboxActor actor, string id, CancellationToken ct)
    {
        var view = await service.ReadAsync(actor, id, ct);
        if (view.State != "running") return new(view.State, []);
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            var response = await SendAsync(actor, id, new("GET", "/api/apps"), timeout.Token);
            if (response.Status is 401 or 403) return new("sign-in-required", [], "Sign in with a sandbox administrator to inspect its apps.");
            if (response.Status != 200 || response.Body is not { } body || !body.TryGetProperty("apps", out var apps)
                || apps.ValueKind != JsonValueKind.Array) return new("unavailable", [], "The child Core did not return its application inventory.");
            return new("ready", apps.EnumerateArray().Select(app => ProjectApp(app, view.PreviewUrl)).ToArray());
        }
        catch (SandboxException ex) when (ex.Code == "environment_setup_required") { return new("setup-required", []); }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or SandboxException)
        { if (ct.IsCancellationRequested) throw; return new("unavailable", [], "Application status is unavailable. Refresh to try again."); }
    }
    internal static CoreEnvironmentApp ProjectApp(JsonElement app, string origin)
    {
        static string? Text(JsonElement value, string key) => value.ValueKind == JsonValueKind.Object
            && value.TryGetProperty(key, out var field) && field.ValueKind == JsonValueKind.String ? field.GetString() : null;
        var appId = Text(app, "id") ?? "";
        var health = app.ValueKind == JsonValueKind.Object && app.TryGetProperty("health", out var snapshot) ? Text(snapshot, "status") : null;
        // Use Core's existing installation-bound navigation contract. It performs normal login,
        // verifies the installed app/surface, and lets the destination SDK obtain its own identity.
        var installation = Text(app, "installationId");
        var endpoint = Text(app, "entryEndpoint");
        var route = Text(app, "entryPath");
        var preview = Text(app, "embeddedUrl") is not null && installation is not null && endpoint is not null && route is not null
            ? Microsoft.AspNetCore.WebUtilities.QueryHelpers.AddQueryString(origin + "/api/apps/" + Uri.EscapeDataString(appId) + "/open",
                new Dictionary<string, string?> { ["installationId"] = installation, ["endpoint"] = endpoint, ["route"] = route }) : null;
        return new(appId, Text(app, "displayName") ?? appId, Text(app, "version"), Text(app, "runtimeState") ?? "unknown", health, preview);
    }
    private static void RequireRunning(CoreEnvironmentRecord record)
    {
        if (record.State != "running" || !CoreEnvironmentRuntime.Alive(record.Process))
            throw new SandboxException("environment_not_running", "Start the child Core first.", 409);
    }
    private static async Task<CoreEnvironmentApiResponse> ResultAsync(HttpResponseMessage response, CancellationToken ct)
    {
        await response.Content.LoadIntoBufferAsync(4 * 1024 * 1024, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        if (string.IsNullOrWhiteSpace(text)) return new((int)response.StatusCode, null);
        try { using var document = JsonDocument.Parse(text); return new((int)response.StatusCode, document.RootElement.Clone()); }
        catch (JsonException) { throw new SandboxException("environment_api_not_json", "The selected child endpoint did not return JSON.", 409); }
    }
}
