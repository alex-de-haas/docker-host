using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace HostySdk.App;

/// <summary>Application-supplied exact-operation authorization; never send a Core user credential to the provider.</summary>
public delegate Task<HostyAgentAuthorization> HostyAgentAuthorizer(HostyAgentAuthorizationRequest request, CancellationToken cancellationToken);
/// <summary>Persist the exact body before sending. Reusing its UUID and bytes recovers a lost acknowledgement.</summary>
public record HostyAgentPreparedRequest(HostyAgentAuthorizationRequest Authorization, string Body);
/// <summary>A stable instruction block supplied by the consumer.</summary>
public record HostyAgentInstruction(string Id, string Text);
/// <summary>A connection revision; native account identity is provider-private and fixed after initialization.</summary>
public record HostyAgentConnectionSelection(string Id, string Revision);
/// <summary>Append instructions to the provider's base instructions.</summary>
public record HostyAgentSystemPrompt(string Mode, string Text);
/// <summary>Native child-agent policy. Capability discovery determines whether enforcement is available.</summary>
public record HostyAgentSubagentPolicy(bool Enabled, int? MaxConcurrency = null);
/// <summary>Optional native prediction output, gated by provider capabilities.</summary>
public record HostyAgentPredictions(bool Enabled);
/// <summary>Immutable desired configuration; applying it is a run preparation effect.</summary>
public record HostyAgentConfiguration(HostyAgentConnectionSelection Connection, HostyAgentInstruction[]? Instructions = null,
    HostyAgentSystemPrompt? SystemPrompt = null, HostyAgentSkillSelection[]? Skills = null, string? NativeTools = null,
    string? ApprovalMode = null, HostyAgentSubagentPolicy? Subagents = null, HostyAgentPredictions? Predictions = null);
/// <summary>Optional application-owned conversation or task correlation, without native SDK identifiers.</summary>
public record HostyAgentCorrelation(HostyConversationRef? Conversation = null, HostyTaskRef? Task = null);
/// <summary>Create provider metadata lazily. Native state is initialized only after a run is durably admitted.</summary>
public record HostyAgentSessionCreate(HostyAgentConfiguration Configuration, string[]? RequiredCapabilities = null, HostyAgentCorrelation? Correlation = null);
/// <summary>Create a desired configuration revision under the expected session revision.</summary>
public record HostyAgentConfigurationCreate(string RequestId, string ExpectedSessionRevision, HostyAgentConfiguration Configuration, string[]? RequiredCapabilities = null);
/// <summary>One provider-owned, immutable uploaded attachment reference.</summary>
public record HostyAgentAttachment(HostyProviderRef Owner, string Id, string Digest, long SizeBytes, string MediaType, string? Name = null);
/// <summary>One base64 chunk; at most 512 KiB decoded and 25 MiB per completed attachment.</summary>
public record HostyAgentAttachmentChunk(string Digest, long SizeBytes, string MediaType, int Count, string Data, string? Name = null);
/// <summary>Upload progress and the completed immutable asset reference.</summary>
public record HostyAgentAttachmentChunkReceipt(HostyAgentAttachment? Attachment, int[] Received);
/// <summary>A provider-retained answer for an explicit next turn.</summary>
public record HostyAgentDecisionResponseRef(string RunId, string RequestId);
/// <summary>A new user input or explicit next-turn decision reference.</summary>
public record HostyAgentInput(string? Text = null, HostyAgentAttachment[]? Attachments = null, HostyAgentDecisionResponseRef? DecisionResponseRef = null);
/// <summary>Requested model and reasoning selection, with explicit null defaults.</summary>
public record HostyAgentSelection([property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Model,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? ReasoningEffort);
/// <summary>Optional execution limits; a provider rejects unsupported guarantees.</summary>
public record HostyAgentRunLimits(long? MaxDurationMs = null, long? MaxOutputTokens = null, long? MaxToolCalls = null);
/// <summary>Explicit start/resume input. Resume failure is reported rather than starting new history.</summary>
public record HostyAgentRunCreate(string ExpectedSessionRevision, string ConfigurationRevision, string Continuation,
    HostyAgentInput Input, HostyAgentInstruction[]? Context = null, HostyAgentSelection? Selection = null,
    HostyAgentResource[]? Resources = null, HostyAgentMcpSelection? Mcp = null, string[]? RequiredCapabilities = null, HostyAgentRunLimits? Limits = null);
/// <summary>Public execution session metadata, separate from Core's cross-provider session inventory.</summary>
public record HostyAgentExecutionSession(HostyNativeSessionRef Ref, string Revision, string ConfigurationRevision,
    string ConfigurationDigest, string NativeState, HostyRunRef? ActiveRun, HostyAgentPinnedSkill[] ResolvedSkills,
    HostyAgentConfiguration? Configuration = null, HostyAgentCorrelation? Correlation = null);
/// <summary>A bounded provider-owned session page.</summary>
public record HostyAgentExecutionSessionPage(HostyAgentExecutionSession[] Sessions, string? NextCursor);
/// <summary>Provider-owned truth. Terminal status does not imply process-tree stop confirmation.</summary>
public record HostyAgentExecutionSnapshot(HostyRunRef Ref, string SessionId, string Generation, string Revision,
    string State, string Phase, bool StopConfirmed, string Freshness, DateTimeOffset ObservedAt,
    string ConfigurationRevision, string LastSequence, string Cursor, JsonElement[] Pending, JsonElement Effects,
    JsonElement? Result = null, JsonElement[]? Messages = null, JsonElement[]? Tools = null,
    JsonElement[]? Agents = null, JsonElement? Selection = null, string? AdmissionRef = null,
    JsonElement? LatestContext = null);
/// <summary>A requested control receipt, independent of terminal execution truth.</summary>
public record HostyAgentExecutionControlReceipt(string RequestId, string State, HostyRunRef Run, string Revision,
    string? Generation = null, JsonElement? Error = null, JsonElement? Continuation = null);
/// <summary>A sequenced v1 event with native subagent provenance when reported.</summary>
public record HostyAgentExecutionEvent(string SchemaVersion, string RunId, string Generation, string Sequence,
    string Revision, DateTimeOffset OccurredAt, string Type, JsonElement Source, JsonElement Data);
/// <summary>A bounded SSE frame. Keep Cursor for explicit replay after reconnect.</summary>
public record HostyAgentExecutionFrame(string Kind, string? Cursor, HostyAgentExecutionSnapshot? Snapshot = null, HostyAgentExecutionEvent? Event = null);

/// <summary>Direct HTTP/SSE consumer for agent v1. It never retries mutations or silently changes providers.</summary>
/// <param name="http">Use automatic redirects disabled, with a timeout suitable for streaming.</param>
/// <param name="provider">Explicit installation and interface selection.</param>
/// <param name="authorize">Per-request Core authorization callback.</param>
/// <param name="runningInContainer">Rewrite host loopback transport URLs for Docker consumers.</param>
public sealed class HostyAgentExecutionClient(HttpClient http, HostyProviderRef provider, HostyAgentAuthorizer authorize, bool runningInContainer = false)
{
    private const int MaxBytes = 1024 * 1024;
    private static string Segment(string value) => Guid.TryParse(value, out _) ? value : throw new ArgumentException("Use a public UUID.", nameof(value));
    private static string Digest(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    private static HostyAgentPreparedRequest Prepare<T>(string operation, string method, string path, T input,
        System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> type, string? sessionId = null, string? runId = null,
        HostyAgentResource[]? resources = null, HostyAgentAuthorityCeiling? ceiling = null)
    {
        var body = JsonSerializer.Serialize(input, type);
        if (Encoding.UTF8.GetByteCount(body) > MaxBytes) throw new HostyProviderException("payload_budget", "Agent command exceeds 1 MiB.", 413);
        return new(new(operation, method, path, Digest(body), resources, sessionId, runId, Ceiling: ceiling), body);
    }
    /// <summary>Prepare a lazy metadata-only session creation for durable caller persistence.</summary>
    public static HostyAgentPreparedRequest PrepareSession(string sessionId, HostyAgentSessionCreate input)
        => Prepare("sessions.create", "PUT", "/sessions/" + Segment(sessionId), input, AgentJsonContext.Default.HostyAgentSessionCreate, sessionId);
    /// <summary>Prepare a configuration revision without reconfiguring native state.</summary>
    public static HostyAgentPreparedRequest PrepareConfiguration(string sessionId, string configurationId, HostyAgentConfigurationCreate input)
        => Prepare("sessions.configure", "PUT", $"/sessions/{Segment(sessionId)}/configurations/{Segment(configurationId)}", input,
            AgentJsonContext.Default.HostyAgentConfigurationCreate, sessionId);
    /// <summary>Prepare an explicit native start/resume and its exact metadata-only ceiling.</summary>
    public static HostyAgentPreparedRequest PrepareRun(string sessionId, string runId, HostyAgentRunCreate input)
        => Prepare("runs.start", "PUT", $"/sessions/{Segment(sessionId)}/runs/{Segment(runId)}", input,
            AgentJsonContext.Default.HostyAgentRunCreate, sessionId, runId, input.Resources,
            new(input.Mcp, input.Resources, ConfigurationRevision: input.ConfigurationRevision));
    /// <summary>Prepare an approval response, cancellation or capability-gated control using the documented JSON shape.</summary>
    public static HostyAgentPreparedRequest PrepareControl(string runId, string operation, JsonElement input, string? sessionId = null)
    {
        var suffix = operation switch { "runs.respond" => "responses", "runs.cancel" => "cancel", "runs.control" => "controls", _ => throw new ArgumentException("Unknown run control.", nameof(operation)) };
        return Prepare(operation, "POST", $"/runs/{Segment(runId)}/{suffix}", input, AgentJsonContext.Default.JsonElement, sessionId, runId);
    }
    /// <summary>Prepare one immutable attachment chunk with a stable attachment UUID.</summary>
    public static HostyAgentPreparedRequest PrepareAttachmentChunk(string attachmentId, int index, HostyAgentAttachmentChunk input)
    {
        if (index is < 0 or > 49 || input.Count is < 1 or > 50 || index >= input.Count || input.SizeBytes is < 1 or > 25 * 1024 * 1024)
            throw new ArgumentException("Use a bounded attachment chunk.", nameof(input));
        return Prepare("attachments.write", "PUT", $"/attachments/{Segment(attachmentId)}/chunks/{index}", input, AgentJsonContext.Default.HostyAgentAttachmentChunk);
    }
    private async Task<HttpResponseMessage> Response(HostyAgentAuthorizationRequest metadata, string? body, CancellationToken ct, bool stream = false)
    {
        if (!metadata.Path.StartsWith('/') || metadata.Path.StartsWith("//") || metadata.Path.Contains('\\') || metadata.Path.Contains('#')
            || metadata.Path.Contains("..", StringComparison.Ordinal) || metadata.BodyHash != Digest(body ?? ""))
            throw new ArgumentException("The exact body and relative route must match the prepared authorization.");
        var binding = await authorize(metadata, ct);
        if (binding.Provider != provider || binding.ExpiresAt <= DateTimeOffset.UtcNow) throw new HostyProviderException("provider_changed", "The selected provider authorization changed or expired.", 409);
        var uri = new UriBuilder(binding.BaseUrl);
        if (uri.Scheme is not ("http" or "https") || uri.UserName.Length != 0 || uri.Password.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0)
            throw new HostyProviderException("provider_url_invalid", "Invalid provider endpoint.", 409);
        if (runningInContainer && uri.Host is "localhost" or "127.0.0.1" or "[::1]") uri.Host = "host.docker.internal";
        using var request = new HttpRequestMessage(new HttpMethod(metadata.Method), uri.Uri.AbsoluteUri.TrimEnd('/') + metadata.Path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", binding.Token);
        if (stream) request.Headers.Accept.Add(new("text/event-stream"));
        if (body is not null) request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode) { try { await Read(response, ct); } finally { response.Dispose(); } }
        return response;
    }
    private static async Task<JsonElement> Read(HttpResponseMessage response, CancellationToken ct)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        var chunk = new byte[8192]; int count;
        while ((count = await stream.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + count > MaxBytes) throw new HostyProviderException("payload_budget", "Provider response exceeds 1 MiB.", 502);
            await buffer.WriteAsync(chunk.AsMemory(0, count), ct);
        }
        JsonElement value;
        try { value = JsonSerializer.Deserialize(buffer.ToArray(), AgentJsonContext.Default.JsonElement); }
        catch (JsonException) { throw new HostyProviderException("provider_response_invalid", "Invalid provider response.", 502); }
        if (!response.IsSuccessStatusCode)
        {
            var error = value.TryGetProperty("error", out var nested) ? nested : value;
            throw new HostyProviderException(error.TryGetProperty("code", out var code) ? code.GetString() ?? "provider_failed" : "provider_failed",
                error.TryGetProperty("message", out var message) ? message.GetString() ?? "Provider request failed." : "Provider request failed.", (int)response.StatusCode);
        }
        return value;
    }
    private static T Decode<T>(JsonElement value, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> type)
        => value.Deserialize(type) ?? throw new HostyProviderException("provider_response_invalid", "Invalid provider response.", 502);
    /// <summary>Send exactly the persisted command bytes once. Inspect the operation result with typed send helpers.</summary>
    public async Task<JsonElement> SendAsync(HostyAgentPreparedRequest command, CancellationToken cancellationToken = default)
    {
        using var response = await Response(command.Authorization, command.Body, cancellationToken);
        return await Read(response, cancellationToken);
    }
    /// <summary>Send session creation/configuration and verify the public session owner.</summary>
    public async Task<HostyAgentExecutionSession> SendSessionAsync(HostyAgentPreparedRequest command, CancellationToken cancellationToken = default)
    {
        var value = Decode(await SendAsync(command, cancellationToken), AgentJsonContext.Default.HostyAgentExecutionSession);
        if (value.Ref.Provider != provider || value.Ref.Id != command.Authorization.SessionId) throw new HostyProviderException("provider_response_invalid", "Session identity changed.", 502);
        return value;
    }
    /// <summary>Send native run admission and verify the public run owner.</summary>
    public async Task<HostyAgentExecutionSnapshot> SendRunAsync(HostyAgentPreparedRequest command, CancellationToken cancellationToken = default)
    {
        var value = Decode(await SendAsync(command, cancellationToken), AgentJsonContext.Default.HostyAgentExecutionSnapshot);
        if (value.Ref.Provider != provider || value.Ref.Id != command.Authorization.RunId || value.SessionId != command.Authorization.SessionId)
            throw new HostyProviderException("provider_response_invalid", "Run identity changed.", 502);
        return value;
    }
    /// <summary>Read one exact documented GET operation, including capabilities, connections/models, sessions or runs.</summary>
    public async Task<JsonElement> GetAsync(string operation, string path, string? sessionId = null, string? runId = null, CancellationToken cancellationToken = default)
    {
        using var response = await Response(new(operation, "GET", path, Digest(""), SessionId: sessionId, RunId: runId), null, cancellationToken);
        return await Read(response, cancellationToken);
    }
    /// <summary>Read the authoritative snapshot before resuming replay.</summary>
    public async Task<HostyAgentExecutionSnapshot> RunAsync(string runId, CancellationToken cancellationToken = default)
    {
        var value = Decode(await GetAsync("runs.read", "/runs/" + Segment(runId), runId: runId, cancellationToken: cancellationToken), AgentJsonContext.Default.HostyAgentExecutionSnapshot);
        if (value.Ref.Provider != provider || value.Ref.Id != runId) throw new HostyProviderException("provider_response_invalid", "Run identity changed.", 502);
        return value;
    }
    private static async IAsyncEnumerable<string> Lines(StreamReader reader, [EnumeratorCancellation] CancellationToken ct)
    {
        var pending = new StringBuilder(); var chunk = new char[4096]; int count; var bytes = 0;
        while ((count = await reader.ReadAsync(chunk.AsMemory(), ct)) > 0)
            for (var i = 0; i < count; i++)
            {
                if (chunk[i] == '\n') { yield return pending.ToString().TrimEnd('\r'); pending.Clear(); bytes = 0; }
                else { pending.Append(chunk[i]); bytes += chunk[i] <= 0x7f ? 1 : chunk[i] <= 0x7ff ? 2 : 3;
                    if (bytes > MaxBytes) throw new HostyProviderException("payload_budget", "SSE line exceeds its byte allowance.", 502); }
            }
    }
    /// <summary>Read a bounded SSE stream once. Persist cursors; reconnect explicitly and handle replay-expired snapshot recovery.</summary>
    public async IAsyncEnumerable<HostyAgentExecutionFrame> EventsAsync(string runId, string? cursor = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var path = $"/runs/{Segment(runId)}/events" + (cursor is null ? "" : "?after=" + Uri.EscapeDataString(cursor));
        using var response = await Response(new("runs.events", "GET", path, Digest(""), RunId: runId), null, cancellationToken, stream: true);
        if (response.Content.Headers.ContentType?.MediaType != "text/event-stream") throw new HostyProviderException("provider_response_invalid", "An SSE response is required.", 502);
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(cancellationToken), Encoding.UTF8);
        var data = new StringBuilder(); string? id = null; string kind = "message";
        await foreach (var line in Lines(reader, cancellationToken))
        {
            if (line.Length > MaxBytes || data.Length + line.Length > MaxBytes) throw new HostyProviderException("payload_budget", "SSE frame exceeds its byte allowance.", 502);
            if (line.Length == 0)
            {
                if (data.Length > 0)
                {
                    var value = JsonSerializer.Deserialize(data.ToString(), AgentJsonContext.Default.JsonElement);
                    if (kind == "snapshot")
                    {
                        var snapshot = Decode(value, AgentJsonContext.Default.HostyAgentExecutionSnapshot);
                        if (snapshot.Ref.Provider != provider || snapshot.Ref.Id != runId) throw new HostyProviderException("provider_response_invalid", "Snapshot identity changed.", 502);
                        yield return new("snapshot", id, Snapshot: snapshot);
                    }
                    else if (kind == "agent")
                    {
                        if (string.IsNullOrEmpty(id)) throw new HostyProviderException("provider_response_invalid", "An event replay cursor is required.", 502);
                        var item = Decode(value, AgentJsonContext.Default.HostyAgentExecutionEvent);
                        if (item.SchemaVersion != "agent-event.1" || item.RunId != runId) throw new HostyProviderException("provider_response_invalid", "Event schema or identity changed.", 502);
                        yield return new("event", id, Event: item);
                    }
                }
                data.Clear(); id = null; kind = "message";
            }
            else if (line.StartsWith("data:", StringComparison.Ordinal)) { if (data.Length > 0) data.Append('\n'); data.Append(line[5..].TrimStart(' ')); }
            else if (line.StartsWith("id:", StringComparison.Ordinal)) id = line[3..].TrimStart(' ');
            else if (line.StartsWith("event:", StringComparison.Ordinal)) kind = line[6..].TrimStart(' ');
        }
    }
}

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(JsonElement))]
[JsonSerializable(typeof(HostyAgentSessionCreate))]
[JsonSerializable(typeof(HostyAgentConfigurationCreate))]
[JsonSerializable(typeof(HostyAgentRunCreate))]
[JsonSerializable(typeof(HostyAgentAttachmentChunk))]
[JsonSerializable(typeof(HostyAgentExecutionSession))]
[JsonSerializable(typeof(HostyAgentExecutionSnapshot))]
[JsonSerializable(typeof(HostyAgentExecutionEvent))]
internal partial class AgentJsonContext : JsonSerializerContext;
