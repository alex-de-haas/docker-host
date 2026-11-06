using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace HostySdk.App;

/// <summary>Core decision operations with current app/user authority and no automatic mutation retries.
/// Supply an HttpClient with redirects disabled; never persist the user credential in a wait.</summary>
public sealed class HostyDecisionClient(HttpClient http, HostyAppOptions options, Func<CancellationToken, Task<string>> userToken)
{
    /// <summary>Create an addressed question under a stable request UUID.</summary>
    public Task<HostyDecisionRecord> CreateAsync(HostyDecisionCreate input, CancellationToken ct = default) => Send<HostyDecisionRecord>("/requests", input, ct);
    /// <summary>Read current authorized state.</summary>
    public Task<HostyDecisionRecord> GetAsync(string id, CancellationToken ct = default) => Send<HostyDecisionRecord>(Route(id), null, ct);
    /// <summary>Read a bounded authorized page, including the current pending count.</summary>
    public Task<HostyDecisionPage> ListAsync(HostyDecisionQuery? query = null, CancellationToken ct = default) => Send<HostyDecisionPage>("/requests" + Query(query), null, ct);
    /// <summary>Submit an explicit answer against the displayed revision.</summary>
    public Task<HostyDecisionRecord> ResolveAsync(string id, HostyDecisionResolve input, CancellationToken ct = default) => Send<HostyDecisionRecord>(Route(id) + "/resolve", input, ct);
    /// <summary>Withdraw an originating source question, preserving any accepted answer.</summary>
    public Task<HostyDecisionRecord> WithdrawAsync(string id, HostyDecisionWithdraw input, CancellationToken ct = default) => Send<HostyDecisionRecord>(Route(id) + "/withdraw", input, ct);
    /// <summary>Fence stale inputs without modifying their original snapshot.</summary>
    public Task<HostyDecisionRecord> InvalidateAsync(string id, HostyDecisionWithdraw input, CancellationToken ct = default) => Send<HostyDecisionRecord>(Route(id) + "/invalidate", input, ct);
    /// <summary>Reconcile this originating installation's outstanding response deliveries.</summary>
    public Task<HostyDecisionPage> ResponsesAsync(HostyDecisionQuery? query = null, CancellationToken ct = default) => Send<HostyDecisionPage>("/responses" + Query(query), null, ct);
    /// <summary>Acknowledge only after the source inbox and continuation command are durable.</summary>
    public Task<HostyDecisionRecord> AcknowledgeAsync(string id, HostyDecisionAck input, CancellationToken ct = default) => Send<HostyDecisionRecord>("/responses/" + Uri.EscapeDataString(id) + "/ack", input, ct);
    /// <summary>Record continuation progress; acknowledgement and completion are separate states.</summary>
    public Task<HostyDecisionRecord> ContinuationAsync(string id, HostyDecisionContinue input, CancellationToken ct = default) => Send<HostyDecisionRecord>(Route(id) + "/continuation", input, ct);
    private static string Route(string id) => "/requests/" + Uri.EscapeDataString(id);
    private static string Query(HostyDecisionQuery? input)
    {
        var query = input ?? new();
        var items = new Dictionary<string, string?> { ["cursor"] = query.Cursor, ["limit"] = query.Limit.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["state"] = query.State, ["subject"] = query.Subject, ["task"] = query.Task };
        return "?" + string.Join("&", items.Where(p => p.Value is not null).Select(p => p.Key + "=" + Uri.EscapeDataString(p.Value!)));
    }
    private async Task<T> Send<T>(string path, object? body, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(options.ServiceToken)) throw new InvalidOperationException("Hosty service credentials are required.");
        var token = await userToken(ct);
        if (string.IsNullOrEmpty(token)) throw new InvalidOperationException("A current user identity is required.");
        using var request = new HttpRequestMessage(body is null ? HttpMethod.Get : HttpMethod.Post,
            new Uri(new Uri(options.CoreOrigin), "/api/internal/apps/" + Uri.EscapeDataString(options.AppId) + "/decisions/v1" + path));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.ServiceToken);
        request.Headers.Add("X-Hosty-User-Token", token);
        if (body is not null) request.Content = JsonContent.Create(body, DecisionJsonContext.Default.GetTypeInfo(body.GetType())!);
        using var response = await http.SendAsync(request, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
        {
            DecisionFailure? failure = null;
            try { failure = JsonSerializer.Deserialize(text, DecisionJsonContext.Default.DecisionFailure); } catch (JsonException) { }
            throw new HostyProviderException(failure?.Error?.Code ?? "decision_unavailable", failure?.Error?.Message ?? "Decision operation failed.", (int)response.StatusCode);
        }
        return (T)(JsonSerializer.Deserialize(text, DecisionJsonContext.Default.GetTypeInfo(typeof(T))!) ?? throw new JsonException("No decision result."));
    }
}
internal sealed record DecisionFailure(DecisionFailureDetail? Error);
internal sealed record DecisionFailureDetail(string Code, string Message);
[JsonSourceGenerationOptions(JsonSerializerDefaults.Web, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(HostyDecisionCreate))]
[JsonSerializable(typeof(HostyDecisionResolve))]
[JsonSerializable(typeof(HostyDecisionWithdraw))]
[JsonSerializable(typeof(HostyDecisionAck))]
[JsonSerializable(typeof(HostyDecisionContinue))]
[JsonSerializable(typeof(HostyDecisionRecord))]
[JsonSerializable(typeof(HostyDecisionPage))]
[JsonSerializable(typeof(DecisionFailure))]
internal partial class DecisionJsonContext : JsonSerializerContext;
