using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace HostySdk.App;

/// <summary>A confirmed, versioned provider and its current availability.</summary>
public sealed record HostyProvider(string AppId, string DisplayName, string Kind, string Key,
    int? Version, string[] Capabilities, string? Url, bool Available);
/// <summary>The app's reviewed permission declarations and effective grants.</summary>
public sealed record HostyProviderPermissions(string[] Required, string[] Optional, string[] Granted);
/// <summary>Authority for one provider invocation, revalidated against live Core state.</summary>
public sealed record HostyProviderInvocation(string CallerAppId, string CallerInstallation, string? UserId, string? HostRole, string Kind, string Key);
/// <summary>The recognized text. Language is absent when the engine did not report one.</summary>
public sealed record HostySpeechResult(string Text, string? Language = null);
/// <summary>A provider's speech input contract and readiness.</summary>
public sealed record HostySpeechCapabilities(int Version, string[] MediaTypes, long MaxBytes, int MaxDurationSeconds, string Backend, bool Ready);
/// <summary>An error with a stable code and HTTP status.</summary>
public sealed class HostyProviderException(string code, string message, int statusCode) : Exception(message)
{
    /// <summary>Core or provider error code.</summary>
    public string Code { get; } = code;
    /// <summary>HTTP response status.</summary>
    public int StatusCode { get; } = statusCode;
}

/// <summary>Server-side discovery, speech consumption and provider authorization. Never expose its service token to clients.</summary>
/// <param name="http">An HTTP client with automatic redirects disabled and a suitable inference timeout.</param>
/// <param name="options">The consuming or providing app's Core credentials.</param>
public sealed class HostyProviderClient(HttpClient http, HostyAppOptions options)
{
    /// <summary>Read effective grants. No provider permission is required to read one's own grants.</summary>
    public Task<HostyProviderPermissions> PermissionsAsync(CancellationToken cancellationToken = default)
        => CoreAsync<HostyProviderPermissions>("/permissions", null, null, cancellationToken);

    /// <summary>List all confirmed providers of the requested category, including unavailable ones.</summary>
    public async Task<IReadOnlyList<HostyProvider>> ListAsync(string kind, CancellationToken cancellationToken = default)
    {
        RequireKind(kind);
        return (await CoreAsync<ProviderList>($"/providers/{kind}", null, null, cancellationToken)).Providers;
    }

    /// <summary>Validate a credential for this provider on every request. Do not cache the result.</summary>
    public Task<HostyProviderInvocation> ValidateAsync(string token, string kind, string key = "default", CancellationToken cancellationToken = default)
    {
        RequireKind(kind);
        return CoreAsync<HostyProviderInvocation>("/provider/introspect", new ProviderValidation(token, kind, key), null, cancellationToken);
    }

    /// <summary>Read the selected speech provider's supported formats, limits and readiness.</summary>
    public async Task<HostySpeechCapabilities> SpeechCapabilitiesAsync(HostyProvider provider, CancellationToken cancellationToken = default)
    {
        var binding = await ConnectAsync(provider, "speech-to-text", null, cancellationToken);
        using var request = ProviderRequest(binding, HttpMethod.Get, "/capabilities");
        using var response = await http.SendAsync(request, cancellationToken);
        return await ReadAsync<HostySpeechCapabilities>(response, cancellationToken);
    }

    /// <summary>Transcribe a completed recording. Audio is sent directly to the chosen provider.</summary>
    public async Task<HostySpeechResult> TranscribeAsync(HostyProvider provider, ReadOnlyMemory<byte> audio,
        string mediaType = "audio/wav", string? language = null, CancellationToken cancellationToken = default)
    {
        var binding = await ConnectAsync(provider, "speech-to-text", null, cancellationToken);
        var suffix = "/transcriptions" + (language is null ? "" : "?language=" + Uri.EscapeDataString(language));
        using var request = ProviderRequest(binding, HttpMethod.Post, suffix);
        request.Content = new ReadOnlyMemoryContent(audio);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue(mediaType);
        using var response = await http.SendAsync(request, cancellationToken);
        return await ReadAsync<HostySpeechResult>(response, cancellationToken);
    }

    /// <summary>Send a version-one assistant handoff operation, authenticated as the supplied acting user.
    /// The relative route must be within /handoffs. The caller owns content and response disposal.</summary>
    public async Task<HttpResponseMessage> SendAssistantAsync(HostyProvider provider, string userToken,
        HttpMethod method, string route, HttpContent? content = null, CancellationToken cancellationToken = default)
    {
        if (!(route == "/handoffs" || route.StartsWith("/handoffs/", StringComparison.Ordinal))
            || route.Contains("..", StringComparison.Ordinal) || route.Contains('\\') || route.Contains('#'))
            throw new ArgumentException("Use a relative assistant handoff route.", nameof(route));
        var binding = await ConnectAsync(provider, "assistant", userToken, cancellationToken);
        using var request = ProviderRequest(binding, method, route);
        request.Content = content;
        try { return await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken); }
        finally { request.Content = null; }
    }

    private async Task<ProviderBinding> ConnectAsync(HostyProvider provider, string kind, string? userToken, CancellationToken ct)
    {
        if (provider.Kind != kind) throw new ArgumentException("Provider category does not match the operation.", nameof(provider));
        var binding = await CoreAsync<ProviderBinding>($"/providers/{kind}/token", new ProviderSelection(provider.AppId, provider.Key), userToken, ct);
        if (binding.Provider.Version != 1 || binding.Provider.Url is null)
            throw new HostyProviderException("provider_incompatible", "Provider does not support interface version 1.", 409);
        return binding;
    }
    private HttpRequestMessage ProviderRequest(ProviderBinding binding, HttpMethod method, string suffix)
    {
        var uri = new UriBuilder(binding.Provider.Url!);
        if (uri.Scheme is not ("http" or "https") || uri.UserName.Length != 0 || uri.Password.Length != 0)
            throw new HostyProviderException("provider_url_invalid", "Invalid provider URL.", 409);
        if ((options.RunningInContainer || new Uri(options.CoreOrigin).Host == "host.docker.internal") && uri.Host is "localhost" or "127.0.0.1" or "[::1]")
            uri.Host = "host.docker.internal";
        var request = new HttpRequestMessage(method, uri.Uri.AbsoluteUri.TrimEnd('/') + suffix);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", binding.Token);
        return request;
    }
    private async Task<T> CoreAsync<T>(string route, object? body, string? userToken, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(options.ServiceToken)) throw new HostyProviderException("hosty_misconfigured", "App service credentials are missing.", 503);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(10));
        using var request = new HttpRequestMessage(body is null ? HttpMethod.Get : HttpMethod.Post,
            new Uri(new Uri(options.CoreOrigin), $"/api/internal/apps/{Uri.EscapeDataString(options.AppId)}{route}"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.ServiceToken);
        if (userToken is not null) request.Headers.Add("X-Hosty-User-Token", userToken);
        if (body is not null) request.Content = JsonContent.Create(body, ProviderJsonContext.Default.GetTypeInfo(body.GetType())!);
        using var response = await http.SendAsync(request, deadline.Token);
        return await ReadAsync<T>(response, deadline.Token);
    }
    private static async Task<T> ReadAsync<T>(HttpResponseMessage response, CancellationToken ct)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        if (!response.IsSuccessStatusCode)
        {
            ProviderFailure? failure = null;
            try { failure = await JsonSerializer.DeserializeAsync(stream, ProviderJsonContext.Default.ProviderFailure, ct); }
            catch (JsonException) { }
            throw new HostyProviderException(failure?.Code ?? "provider_failed", failure?.Message ?? "Provider request failed.", (int)response.StatusCode);
        }
        var value = await JsonSerializer.DeserializeAsync(stream, ProviderJsonContext.Default.GetTypeInfo(typeof(T))!, ct);
        return value is T result ? result : throw new HostyProviderException("provider_response_invalid", "Invalid provider response.", 502);
    }
    private static void RequireKind(string kind)
    {
        if (kind is not ("speech-to-text" or "assistant")) throw new ArgumentException("Unknown provider category.", nameof(kind));
    }
}

internal sealed record ProviderList(HostyProvider[] Providers);
internal sealed record ProviderSelection(string ProviderAppId, string Key);
internal sealed record ProviderBinding(string Token, DateTimeOffset ExpiresAt, HostyProvider Provider);
internal sealed record ProviderValidation(string Token, string Kind, string Key);
internal sealed record ProviderFailure(string Code, string Message);
[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
[JsonSerializable(typeof(ProviderList))]
[JsonSerializable(typeof(ProviderSelection))]
[JsonSerializable(typeof(ProviderBinding))]
[JsonSerializable(typeof(ProviderValidation))]
[JsonSerializable(typeof(ProviderFailure))]
[JsonSerializable(typeof(HostyProviderPermissions))]
[JsonSerializable(typeof(HostyProviderInvocation))]
[JsonSerializable(typeof(HostySpeechResult))]
[JsonSerializable(typeof(HostySpeechCapabilities))]
internal partial class ProviderJsonContext : JsonSerializerContext;
