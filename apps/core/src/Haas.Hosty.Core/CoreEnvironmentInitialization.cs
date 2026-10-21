using System.Text;
using System.Text.Json;
using Haas.Hosty.Initialization;

namespace Haas.Hosty.Core;

// Bounded, fixed control-plane calls used by the manager. Never accepts a caller-supplied URL,
// arbitrary control path, child password or browser session.
internal static class CoreEnvironmentInitialization
{
    internal static async Task<T> SendAsync<T>(CoreEnvironmentRecord record, string root, string path,
        bool write, string? json, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        ct = timeout.Token;
        var discovery = await JsonStorage.ReadAsync<ControlDiscoveryDocument>(Path.Combine(root, "core", "run", "control.json"), ct);
        if (discovery is null || !Uri.TryCreate(discovery.ControlBaseUrl, UriKind.Absolute, out var uri)
            || !uri.IsLoopback || uri.Scheme != "http" || uri.Port != record.Port || uri.AbsolutePath.TrimEnd('/') != "/control/v1"
            || record.Process is null || discovery.ProcessId != record.Process.Pid || !CoreEnvironmentRuntime.Alive(record.Process))
            throw new SandboxException("environment_not_ready", "The selected child's control endpoint is not ready.", 409);
        using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false });
        using var request = new HttpRequestMessage(write ? HttpMethod.Post : HttpMethod.Get, discovery.ControlBaseUrl.TrimEnd('/') + "/" + path);
        foreach (var header in discovery.RequiredHeaders) request.Headers.TryAddWithoutValidation(header.Key, header.Value);
        if (json is not null) request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        await response.Content.LoadIntoBufferAsync(1024 * 1024, ct);
        if (!response.IsSuccessStatusCode)
        {
            // Do not echo arbitrary child responses into parent inventory or logs.
            var error = response.StatusCode == System.Net.HttpStatusCode.NotFound
                ? "The selected Core does not support initialization. Use a compatible Core build."
                : "The child refused this initialization operation. Check its initialization status and logs.";
            throw new SandboxException("environment_initialization_refused", error, 409);
        }
        var value = JsonSerializer.Deserialize(await response.Content.ReadAsStringAsync(ct), CoreJson.TypeInfo<T>());
        return value ?? throw new SandboxException("environment_initialization_invalid", "The child returned no initialization result.", 409);
    }
    internal static async Task ResumeAsync(CoreEnvironmentRecord record, string root, CancellationToken ct)
    {
        if (record.Request.Initialization is { } input)
        {
            var status = await SendAsync<InitializationStatus>(record, root, "core/initialization", false, null, ct);
            // Explicit local review may replace a failed selection; never replay a retired request.
            _ = await SendAsync<InitializationStatus>(record, root, "core/initialization", true, CoreJson.Text(status.Request ?? input), ct);
        }
    }
}
