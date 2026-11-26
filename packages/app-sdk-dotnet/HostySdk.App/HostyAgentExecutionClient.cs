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
    JsonElement? LatestContext = null, bool? WriterScopeClosed = null) : IJsonOnDeserialized
{
    void IJsonOnDeserialized.OnDeserialized() => HostyAgentClosure.ValidateWriterEvidence(StopConfirmed, WriterScopeClosed);
}
/// <summary>Physical execution state, accessible to its original cleanup owner.</summary>
public record HostyAgentClosure(HostyRunRef Ref, string SessionId, string Generation, string Revision, string State,
    string Phase, bool StopConfirmed, JsonElement[]? PendingContinuations = null, bool? WriterScopeClosed = null) : IJsonOnDeserialized
{
    void IJsonOnDeserialized.OnDeserialized() => ValidateWriterEvidence(StopConfirmed, WriterScopeClosed);

    internal static void ValidateWriterEvidence(bool stopped, bool? writerScopeClosed)
    {
        if (writerScopeClosed == true && !stopped)
            throw new HostyProviderException("provider_response_invalid", "A closed writer scope requires confirmed agent stop.", 502);
    }
}
/// <summary>A requested control receipt, independent of terminal execution truth.</summary>
public record HostyAgentExecutionControlReceipt(string RequestId, string State, HostyRunRef Run, string Revision,
    string? Generation = null, JsonElement? Error = null, JsonElement? Continuation = null);
/// <summary>A sequenced v1 event with native subagent provenance when reported.</summary>
public record HostyAgentExecutionEvent(string SchemaVersion, string RunId, string Generation, string Sequence,
    string Revision, DateTimeOffset OccurredAt, string Type, JsonElement Source, JsonElement Data);
/// <summary>A bounded SSE frame. Keep Cursor for explicit replay after reconnect.</summary>
public record HostyAgentExecutionFrame(string Kind, string? Cursor, HostyAgentExecutionSnapshot? Snapshot = null, HostyAgentExecutionEvent? Event = null);

/// <summary>One observation from a provider subscription shared across this installation's chats.</summary>
public record HostyAgentHistoryObservation(string SessionId, string RunId, string Generation, string UserId,
    string PrincipalId, HostyAgentExecutionFrame Item, string Cursor, string? Epoch = null, long? SessionPosition = null, bool? SourceHistoryIncomplete = null);

/// <summary>A stable page in the retained installation history.</summary>
public record HostyAgentHistoryPage(HostyAgentHistoryObservation[] Observations, string Through, string? NextCursor);

/// <summary>Connection boundary or the following live observation.</summary>
public record HostyAgentLiveHistoryFrame(string? Through, HostyAgentHistoryObservation? Observation);
/// <summary>Session state and durable history watermark at the requested boundary.</summary>
public record HostyAgentHistorySessionState(string SessionId, string UserId, string PrincipalId, string Epoch,
    long Head, HostyAgentExecutionSnapshot Snapshot, bool? SourceHistoryIncomplete = null);
/// <summary>A page of session states at one common installation boundary.</summary>
public record HostyAgentHistoryStatesPage(string Through, HostyAgentHistorySessionState[] Sessions, string? NextSession);
/// <summary>Consecutive durable facts of a single session.</summary>
public record HostyAgentHistoryRange(HostyAgentHistoryObservation[] Observations, long? NextPosition);

/// <summary>Stable stop command identity, including retries before native admission.</summary>
public sealed record HostyAgentStop(Guid RequestId);
/// <summary>Receipt for erasure of the original delivery copy after physical closure.</summary>
public sealed record HostyAgentDiscardReceipt(string RunId, Guid RequestId, string State);

/// <summary>Direct HTTP/SSE consumer for agent v2. It never retries mutations or silently changes providers.</summary>
/// <param name="http">Use automatic redirects disabled, with a timeout suitable for streaming.</param>
/// <param name="provider">Explicit installation and interface selection.</param>
/// <param name="authorize">Per-request Core authorization callback.</param>
/// <param name="runningInContainer">Rewrite host loopback transport URLs for Docker consumers.</param>
public sealed class HostyAgentExecutionClient(HttpClient http, HostyProviderRef provider, HostyAgentAuthorizer authorize, bool runningInContainer = false)
{
    private const int MaxBytes = 1024 * 1024;
    private const long MaxHistoryPosition = (1L << 53) - 1;
    private static bool HistoryCursor(string? value) => value is { Length: > 0 and <= 8192 } && value.IndexOfAny(['\r', '\n']) < 0;
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
    /// <summary>Prepare a durable stop that targets this run across revision changes and lost responses.</summary>
    public static HostyAgentPreparedRequest PrepareStop(string runId, Guid requestId)
        => Prepare("runs.cancel", "PUT", $"/runs/{Segment(runId)}/stop", new HostyAgentStop(requestId), AgentJsonContext.Default.HostyAgentStop, runId: runId);
    /// <summary>Prepare an approval response, cancellation or capability-gated control using the documented JSON shape.</summary>
    public static HostyAgentPreparedRequest PrepareControl(string runId, string operation, JsonElement input, string? sessionId = null)
    {
        var suffix = operation switch { "runs.respond" => "responses", "runs.cancel" => "stop", "runs.control" => "controls", _ => throw new ArgumentException("Unknown run control.", nameof(operation)) };
        return Prepare(operation, operation == "runs.cancel" ? "PUT" : "POST", $"/runs/{Segment(runId)}/{suffix}", input, AgentJsonContext.Default.JsonElement, sessionId, runId);
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
    private static async Task<JsonElement> Read(HttpResponseMessage response, CancellationToken ct, int maxBytes = MaxBytes)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        var chunk = new byte[8192]; int count;
        while ((count = await stream.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + count > maxBytes) throw new HostyProviderException("payload_budget", "Provider response exceeds its byte allowance.", 502);
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
    /// <summary>Discard the original transcript owner's delivery copy after the run closes.</summary>
    public async Task<HostyAgentDiscardReceipt> DiscardDeliveryAsync(string runId, Guid requestId, CancellationToken cancellationToken = default)
    {
        var command = Prepare("runs.discard", "PUT", $"/runs/{Segment(runId)}/discard", new HostyAgentStop(requestId),
            AgentJsonContext.Default.HostyAgentStop, runId: runId);
        var value = Decode(await SendAsync(command, cancellationToken), AgentJsonContext.Default.HostyAgentDiscardReceipt);
        if (value.RequestId != requestId || value.RunId != runId || value.State != "discarded")
            throw new HostyProviderException("provider_response_invalid", "Delivery discard receipt identity changed.", 502);
        return value;
    }
    /// <summary>Read physical closure without retrieving transcript content.</summary>
    public async Task<HostyAgentClosure> ClosureAsync(string runId, CancellationToken cancellationToken = default)
    {
        var value = Decode(await GetAsync("runs.closure", "/runs/" + Segment(runId) + "/closure", runId: runId, cancellationToken: cancellationToken), AgentJsonContext.Default.HostyAgentClosure);
        if (value.Ref?.Provider != provider || value.Ref.Id != runId || !Guid.TryParse(value.Generation, out _) || string.IsNullOrEmpty(value.SessionId))
            throw new HostyProviderException("provider_response_invalid", "Execution closure identity changed.", 502);
        return value;
    }
    private static async IAsyncEnumerable<string> Lines(StreamReader reader, int maxBytes, [EnumeratorCancellation] CancellationToken ct)
    {
        var pending = new StringBuilder(); var chunk = new char[4096]; int count; var bytes = 0;
        while ((count = await reader.ReadAsync(chunk.AsMemory(), ct)) > 0)
            for (var i = 0; i < count; i++)
            {
                if (chunk[i] == '\n') { yield return pending.ToString().TrimEnd('\r'); pending.Clear(); bytes = 0; }
                else { pending.Append(chunk[i]); bytes += chunk[i] <= 0x7f ? 1 : chunk[i] <= 0x7ff ? 2 : 3;
                    if (bytes > maxBytes) throw new HostyProviderException("payload_budget", "SSE line exceeds its byte allowance.", 502); }
            }
    }
    /// <summary>Read a bounded SSE stream once. Persist cursors; reconnect explicitly and handle replay-expired snapshot recovery.</summary>
    public async IAsyncEnumerable<HostyAgentExecutionFrame> EventsAsync(string runId, string? cursor = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var path = $"/runs/{Segment(runId)}/events" + (cursor is null ? "" : "?after=" + Uri.EscapeDataString(cursor));
        using var response = await Response(new("runs.events", "GET", path, Digest(""), RunId: runId), null, cancellationToken, stream: true);
        if (response.Content.Headers.ContentType?.MediaType != "text/event-stream") throw new HostyProviderException("provider_response_invalid", "An SSE response is required.", 502);
        await foreach (var (kind, id, json) in Frames(response, MaxBytes, cancellationToken))
        {
            var value = JsonSerializer.Deserialize(json, AgentJsonContext.Default.JsonElement);
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
    }

    /// <summary>Read observations for this consumer installation. Save the outer cursor after applying each item.</summary>
    public async IAsyncEnumerable<HostyAgentHistoryObservation> HistoryAsync(HostyAgentHistoryBinding binding, string? cursor = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        using var response = await HistoryResponse(binding, cursor, "text/event-stream", null, null, cancellationToken);
        await foreach (var (kind, id, json) in Frames(response, MaxBytes + 32768, cancellationToken))
        {
            if (kind != "observation") continue;
            var value = JsonSerializer.Deserialize(json, AgentJsonContext.Default.HostyAgentHistoryObservation);
            yield return ValidateHistory(value, id);
        }
    }

    /// <summary>Read retained results through a stable position while the provider continues producing events.</summary>
    public async Task<HostyAgentHistoryPage> HistoryPageAsync(HostyAgentHistoryBinding binding, string? cursor = null,
        string? through = null, int limit = 32, CancellationToken cancellationToken = default)
    {
        if (limit is < 1 or > 100) throw new ArgumentOutOfRangeException(nameof(limit));
        using var response = await HistoryResponse(binding, cursor, "application/json", through, limit, cancellationToken);
        var page = Decode(await Read(response, cancellationToken, 2 * MaxBytes + 32768), AgentJsonContext.Default.HostyAgentHistoryPage);
        if (string.IsNullOrEmpty(page.Through) || (through is not null && through != page.Through)
            || page.Observations is null || page.Observations.Length > limit)
            throw new HostyProviderException("provider_response_invalid", "Invalid history page.", 502);
        foreach (var observation in page.Observations) ValidateHistory(observation, observation?.Cursor);
        if (page.NextCursor is not null && (page.NextCursor == cursor || page.Observations.Length == 0 || page.NextCursor != page.Observations[^1].Cursor))
            throw new HostyProviderException("provider_response_invalid", "History page did not advance.", 502);
        return page;
    }

    /// <summary>The first frame supplies the boundary shared with the state and range reads. An optional previous cursor checks archive ancestry.</summary>
    public async IAsyncEnumerable<HostyAgentLiveHistoryFrame> LiveHistoryAsync(HostyAgentHistoryBinding binding, string? previousCursor = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        if (previousCursor is not null && !HistoryCursor(previousCursor)) throw new ArgumentException("Invalid history cursor.", nameof(previousCursor));
        using var response = await HistoryResponse(binding, previousCursor, "text/event-stream", null, null, cancellationToken, "live");
        var ready = false;
        await foreach (var (kind, id, json) in Frames(response, MaxBytes + 32768, cancellationToken))
        {
            if (kind == "ready" && !ready)
            {
                var value = JsonSerializer.Deserialize(json, AgentJsonContext.Default.JsonElement);
                if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("through", out var boundary)
                    || boundary.ValueKind != JsonValueKind.String || !HistoryCursor(boundary.GetString())) throw InvalidHistory();
                ready = true;
                yield return new(boundary.GetString(), null);
            }
            else if (kind == "observation" && ready)
            {
                var fact = ValidateHistory(JsonSerializer.Deserialize(json, AgentJsonContext.Default.HostyAgentHistoryObservation), id);
                if (string.IsNullOrEmpty(fact.Epoch) || fact.SessionPosition is null or < 1) throw InvalidHistory();
                yield return new(null, fact);
            }
            else throw InvalidHistory();
        }
        if (!ready) throw InvalidHistory();
    }

    /// <summary>Read the state of owned provider sessions even when there is no live subscription.</summary>
    public async Task<HostyAgentHistoryStatesPage> HistoryStatesAsync(HostyAgentHistoryBinding binding, string? through = null,
        string? afterSession = null, int limit = 32, CancellationToken cancellationToken = default)
    {
        if (limit is < 1 or > 100) throw new ArgumentOutOfRangeException(nameof(limit));
        using var response = await HistoryResponse(binding, null, "application/json", through, limit, cancellationToken,
            "states", afterSession is null ? [] : [new("afterSession", afterSession)]);
        var page = Decode(await Read(response, cancellationToken, 2 * MaxBytes + 32768), AgentJsonContext.Default.HostyAgentHistoryStatesPage);
        if (!HistoryCursor(page.Through) || through is not null && through != page.Through || page.Sessions is null
            || page.Sessions.Length > limit || page.Sessions.Any(s => s?.Snapshot?.Ref?.Provider != provider || s.SessionId != s.Snapshot.SessionId
                || string.IsNullOrEmpty(s.SessionId) || string.IsNullOrEmpty(s.Epoch) || string.IsNullOrEmpty(s.UserId) || string.IsNullOrEmpty(s.PrincipalId)
                || s.Head is < 1 or > MaxHistoryPosition || s.SourceHistoryIncomplete == false || !Guid.TryParse(s.Snapshot.Generation, out _)
                || string.IsNullOrEmpty(s.Snapshot.Ref.Id) || !HistoryCursor(s.Snapshot.Cursor))
            || page.NextSession is not null && (page.Sessions.Length == 0 || page.NextSession == afterSession || page.NextSession != page.Sessions[^1].SessionId))
            throw InvalidHistory();
        var previous = afterSession;
        foreach (var session in page.Sessions)
        {
            if (previous is not null && string.CompareOrdinal(session.SessionId, previous) <= 0) throw InvalidHistory();
            previous = session.SessionId;
        }
        return page;
    }

    /// <summary>Read one inclusive interval at a fixed installation boundary.</summary>
    public async Task<HostyAgentHistoryRange> HistoryRangeAsync(HostyAgentHistoryBinding binding, string through,
        string sessionId, string epoch, long from, long to, int limit = 32, CancellationToken cancellationToken = default)
    {
        if (from < 1 || to < from || to > MaxHistoryPosition || limit is < 1 or > 100) throw new ArgumentOutOfRangeException(nameof(from));
        if (!HistoryCursor(through)) throw new ArgumentException("Invalid history boundary.", nameof(through));
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);
        ArgumentException.ThrowIfNullOrWhiteSpace(epoch);
        using var response = await HistoryResponse(binding, null, "application/json", through, limit, cancellationToken,
            "range", [new("sessionId", sessionId), new("epoch", epoch),
            new("from", from.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            new("to", to.ToString(System.Globalization.CultureInfo.InvariantCulture))]);
        var page = Decode(await Read(response, cancellationToken, 2 * MaxBytes + 32768), AgentJsonContext.Default.HostyAgentHistoryRange);
        if (page.Observations is null || page.Observations.Length == 0 || page.Observations.Length > limit) throw InvalidHistory();
        long next = from;
        foreach (var value in page.Observations)
        {
            var fact = ValidateHistory(value, value?.Cursor);
            if (fact.SessionId != sessionId || fact.Epoch != epoch || fact.SessionPosition != next || next > to) throw InvalidHistory();
            next = checked(next + 1);
        }
        if (page.NextPosition != (next > to ? (long?)null : next)) throw InvalidHistory();
        return page;
    }

    /// <summary>Acknowledge a contiguous session position after committing the transcript.</summary>
    public async Task AcknowledgeHistoryAsync(HostyAgentHistoryBinding binding, string sessionId, string epoch, long through, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(sessionId) || string.IsNullOrEmpty(epoch) || through is < 1 or > MaxHistoryPosition)
            throw new ArgumentException("Invalid durable history receipt.");
        using var response = await HistoryResponse(binding, null, "application/json", null, null, cancellationToken, "ack",
            [new("sessionId", sessionId), new("epoch", epoch), new("through", through.ToString(System.Globalization.CultureInfo.InvariantCulture))]);
        var answer = await Read(response, cancellationToken);
        if (!answer.TryGetProperty("through", out var value) || !value.TryGetInt64(out var confirmed) || confirmed != through) throw InvalidHistory();
    }

    private static HostyProviderException InvalidHistory() => new("provider_response_invalid", "Invalid positioned history response.", 502);

    private HostyAgentHistoryObservation ValidateHistory(HostyAgentHistoryObservation? value, string? id)
    {
        if (value?.Item is null || !HistoryCursor(id) || value.SourceHistoryIncomplete == false || value.SessionPosition is < 1 or > MaxHistoryPosition || string.IsNullOrWhiteSpace(value.RunId) || string.IsNullOrWhiteSpace(value.SessionId)
            || !Guid.TryParse(value.Generation, out _) || string.IsNullOrWhiteSpace(value.UserId) || string.IsNullOrWhiteSpace(value.PrincipalId))
            throw new HostyProviderException("provider_response_invalid", "Invalid installation history observation.", 502);
        bool Matches(HostyAgentExecutionSnapshot snapshot) => snapshot.Ref?.Provider == provider && snapshot.Ref.Id == value.RunId
            && snapshot.SessionId == value.SessionId && snapshot.Generation == value.Generation;
        if (value.Item.Kind == "snapshot" && value.Item.Snapshot is { } snapshot && Matches(snapshot))
            return value with { Cursor = id! };
        if (value.Item.Kind != "event" || value.Item.Event is not { } item || item.RunId != value.RunId
            || item.Generation != value.Generation || item.SchemaVersion != "agent-event.1" || string.IsNullOrEmpty(value.Item.Cursor))
            throw new HostyProviderException("provider_response_invalid", "History observation identity changed.", 502);
        if (item.Type == "run.updated")
        {
            if (item.Data.ValueKind != JsonValueKind.Object || !item.Data.TryGetProperty("snapshot", out var raw) || raw.ValueKind != JsonValueKind.Object)
                throw new HostyProviderException("provider_response_invalid", "Run update has no history snapshot.", 502);
            var update = Decode(raw, AgentJsonContext.Default.HostyAgentExecutionSnapshot);
            if (!Matches(update) || update.LastSequence != item.Sequence || update.Revision != item.Revision)
                throw new HostyProviderException("provider_response_invalid", "History update does not match the run watermark.", 502);
        }
        return value with { Cursor = id! };
    }

    private async Task<HttpResponseMessage> HistoryResponse(HostyAgentHistoryBinding binding, string? cursor,
        string accept, string? through, int? limit, CancellationToken ct, string route = "events", KeyValuePair<string, string>[]? parameters = null)
    {
        if (binding.ExpiresAt <= DateTimeOffset.UtcNow || string.IsNullOrEmpty(binding.Token))
            throw new HostyProviderException("authorization_invalid", "History credential expired.", 401);
        var uri = new UriBuilder(binding.Endpoint);
        if (uri.Scheme is not ("http" or "https") || uri.UserName.Length != 0 || uri.Password.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0)
            throw new HostyProviderException("provider_url_invalid", "Invalid provider endpoint.", 409);
        if (runningInContainer && uri.Host is "localhost" or "127.0.0.1" or "[::1]") uri.Host = "host.docker.internal";
        uri.Path = uri.Path.TrimEnd('/') + "/history/" + route;
        var query = new List<string>();
        if (cursor is not null) query.Add("after=" + Uri.EscapeDataString(cursor));
        if (through is not null) query.Add("through=" + Uri.EscapeDataString(through));
        if (limit is not null) query.Add("limit=" + limit.Value.ToString(System.Globalization.CultureInfo.InvariantCulture));
        if (parameters is not null) foreach (var parameter in parameters) query.Add(parameter.Key + "=" + Uri.EscapeDataString(parameter.Value));
        uri.Query = string.Join("&", query);
        using var request = new HttpRequestMessage(route == "ack" ? HttpMethod.Post : HttpMethod.Get, uri.Uri);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", binding.Token);
        request.Headers.Accept.Add(new(accept));
        var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        try
        {
            if (route == "live" && response.StatusCode == System.Net.HttpStatusCode.NotFound)
                throw new HostyProviderException("history_live_unsupported", "The provider does not support live history recovery.", 404);
            if (!response.IsSuccessStatusCode)
            {
                try { await Read(response, ct); }
                catch (HostyProviderException error) when (route == "live" && error.StatusCode == 422
                    && error.Code is "unsupported_operation" or "unsupported_capability")
                {
                    throw new HostyProviderException("history_live_unsupported", "The provider does not support live history recovery.", 404);
                }
            }
            if (response.Content.Headers.ContentType?.MediaType != accept)
                throw new HostyProviderException("provider_response_invalid", "Unexpected history representation.", 502);
            return response;
        }
        catch
        {
            response.Dispose();
            throw;
        }
    }

    private static async IAsyncEnumerable<(string Kind, string? Id, string Data)> Frames(HttpResponseMessage response,
        int maxBytes, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(cancellationToken), Encoding.UTF8);
        var data = new StringBuilder(); string? id = null; string kind = "message";
        await foreach (var line in Lines(reader, maxBytes, cancellationToken))
        {
            if (line.Length > maxBytes || data.Length + line.Length > maxBytes) throw new HostyProviderException("payload_budget", "SSE frame exceeds its byte allowance.", 502);
            if (line.Length == 0)
            {
                if (data.Length > 0) yield return (kind, id, data.ToString());
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
[JsonSerializable(typeof(HostyAgentStop))]
[JsonSerializable(typeof(HostyAgentDiscardReceipt))]
[JsonSerializable(typeof(HostyAgentSessionCreate))]
[JsonSerializable(typeof(HostyAgentConfigurationCreate))]
[JsonSerializable(typeof(HostyAgentRunCreate))]
[JsonSerializable(typeof(HostyAgentAttachmentChunk))]
[JsonSerializable(typeof(HostyAgentExecutionSession))]
[JsonSerializable(typeof(HostyAgentClosure))]
[JsonSerializable(typeof(HostyAgentExecutionSnapshot))]
[JsonSerializable(typeof(HostyAgentExecutionEvent))]
[JsonSerializable(typeof(HostyAgentHistoryObservation))]
[JsonSerializable(typeof(HostyAgentHistoryPage))]
[JsonSerializable(typeof(HostyAgentHistoryStatesPage))]
[JsonSerializable(typeof(HostyAgentHistoryRange))]
internal partial class AgentJsonContext : JsonSerializerContext;
