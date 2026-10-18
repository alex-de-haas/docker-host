using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace HostySdk.App;

/// <summary>Server-only client for an explicitly authorized, scope-bound Core background grant.
/// Use an HTTP client with redirects disabled. Issuance is coalesced; operations are never replayed.</summary>
public sealed class HostyBackgroundClient(HttpClient http, HostyAppOptions options, string grantId, string scopeId)
{
    private readonly SemaphoreSlim mutex = new(1, 1);
    private BackgroundCredential? credential;

    /// <summary>Acquire a short credential. Core checks live delegation and permissions on every dispatch.</summary>
    public async Task<string> TokenAsync(CancellationToken cancellationToken = default)
    {
        await mutex.WaitAsync(cancellationToken);
        try
        {
            if (credential is { } cached && cached.ExpiresAt > DateTimeOffset.UtcNow.AddSeconds(30)) return cached.AccessToken;
            using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(new Uri(options.CoreOrigin),
                $"/api/internal/apps/{Uri.EscapeDataString(options.AppId)}/background/token"));
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.ServiceToken);
            request.Content = JsonContent.Create(new BackgroundReference(grantId, scopeId), BackgroundJsonContext.Default.BackgroundReference);
            using var response = await http.SendAsync(request, cancellationToken);
            response.EnsureSuccessStatusCode();
            credential = await response.Content.ReadFromJsonAsync(BackgroundJsonContext.Default.BackgroundCredential, cancellationToken)
                ?? throw new InvalidOperationException("Core returned no background credential.");
            return credential.AccessToken;
        }
        finally { mutex.Release(); }
    }

    /// <summary>Send one scoped Core operation. Caller owns the request and returned response.</summary>
    public async Task<HttpResponseMessage> SendCoreAsync(HttpRequestMessage request, CancellationToken cancellationToken = default)
    {
        var origin = new Uri(options.CoreOrigin);
        var target = new Uri(origin, request.RequestUri ?? throw new ArgumentException("A Core app route is required."));
        if (target.GetLeftPart(UriPartial.Authority) != origin.GetLeftPart(UriPartial.Authority)
            || !target.AbsolutePath.StartsWith("/api/apps/", StringComparison.Ordinal) || target.UserInfo.Length != 0)
            throw new ArgumentException("Use a Core app operation path.");
        request.RequestUri = target;
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.ServiceToken);
        request.Headers.Remove("X-Hosty-App-Identity");
        request.Headers.Add("X-Hosty-App-Identity", await TokenAsync(cancellationToken));
        return await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
    }
}

internal sealed record BackgroundReference(string GrantId, string ScopeId);
internal sealed record BackgroundCredential(string AccessToken, DateTimeOffset ExpiresAt);
[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
[JsonSerializable(typeof(BackgroundReference))]
[JsonSerializable(typeof(BackgroundCredential))]
internal partial class BackgroundJsonContext : JsonSerializerContext;
