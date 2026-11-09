using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreHistoryAttachmentRead(HostyHistoryEntryRef Entry, string AttachmentId, string Revision, long Offset, int Length);
internal sealed record CoreHistoryAttachmentHandle(string Id, string UserId, string PrincipalId, CoreHistoryAttachmentResolve Input,
    string EntryRevision, CoreHistorySourceAttachment Metadata, DateTimeOffset ExpiresAt);
internal sealed record CoreHistoryAttachmentBytes(byte[] Bytes, CoreHistorySourceAttachment Metadata, long Offset);
internal sealed class CoreHistoryAttachmentHandles(IClock clock)
{
    private readonly ConcurrentDictionary<string, CoreHistoryAttachmentHandle> entries = new(StringComparer.Ordinal);
    internal CoreHistoryAttachmentHandle Add(CoreCapabilityCaller caller, CoreHistoryAttachmentResolve input, string entryRevision, CoreHistorySourceAttachment metadata)
    {
        foreach (var value in entries.Values.Where(e => e.ExpiresAt <= clock.UtcNow)) entries.TryRemove(value.Id, out _);
        if (entries.Values.Count(e => e.UserId == caller.User.Id) >= 256) throw new CoreProviderException("budget_exceeded", "Too many current attachment handles.", 429, true);
        var handle = new CoreHistoryAttachmentHandle(Guid.NewGuid().ToString("N"), caller.User.Id, caller.PrincipalId, input, entryRevision, metadata, clock.UtcNow.AddSeconds(60));
        entries[handle.Id] = handle; return handle;
    }
    internal CoreHistoryAttachmentHandle Get(CoreCapabilityCaller caller, string id)
        => entries.TryGetValue(id, out var handle) && handle.UserId == caller.User.Id && handle.PrincipalId == caller.PrincipalId && handle.ExpiresAt > clock.UtcNow
            ? handle : throw new CoreProviderException("cursor_expired", "Resolve this attachment again with the current caller.", 410);
}
internal sealed partial class CoreHistoryAdapter
{
    internal async Task<CoreHistoryAttachment> AttachmentAsync(CoreCapabilityCaller caller, CoreHistoryAttachmentResolve input,
        CoreHistoryAttachmentHandles handles, CancellationToken ct)
    {
        CoreHistoryValidation.EntryRef(input.Entry); CoreProviderMediation.ValidateId(input.AttachmentId); CoreAgentSessionAdapter.Revision(input.Revision);
        var entry = (await EntryAsync(caller, new(input.Entry), ct)).Deserialize(CoreJson.TypeInfo<HostyHistoryEntry>())!;
        RequireAttachment(entry, input);
        var result = await Send(caller, input.Entry.Conversation.Provider, "attachments.resolve", "POST", "/attachments/resolve", input,
            [input.Entry.Conversation.Id, input.Entry.Id, input.AttachmentId], null, ct);
        var metadata = result.Deserialize(CoreJson.TypeInfo<CoreHistorySourceAttachment>()) ?? throw Invalid();
        if (metadata.AttachmentId != input.AttachmentId || metadata.Revision != input.Revision || metadata.SizeBytes < 0
            || string.IsNullOrWhiteSpace(metadata.Name) || metadata.Name.Length > 1000 || metadata.Name.Any(char.IsControl)
            || !MediaTypeHeaderValue.TryParse(metadata.MediaType, out _)) throw Invalid();
        var handle = handles.Add(caller, input, entry.Revision, metadata);
        return new(metadata.AttachmentId, metadata.Revision, metadata.Name, metadata.MediaType, metadata.SizeBytes,
            "/api/history/v1/attachments/" + handle.Id, handle.ExpiresAt);
    }
    internal async Task<CoreHistoryAttachmentBytes> AttachmentBytesAsync(CoreCapabilityCaller caller, string id, string? range,
        CoreHistoryAttachmentHandles handles, CancellationToken ct)
    {
        var handle = handles.Get(caller, id);
        var entry = (await EntryAsync(caller, new(handle.Input.Entry, handle.EntryRevision), ct)).Deserialize(CoreJson.TypeInfo<HostyHistoryEntry>())!;
        RequireAttachment(entry, handle.Input);
        var size = handle.Metadata.SizeBytes; long offset = 0, end = size - 1;
        if (!string.IsNullOrEmpty(range))
        {
            if (!RangeHeaderValue.TryParse(range, out var parsed) || parsed.Unit != "bytes" || parsed.Ranges.Count != 1)
                throw new CoreProviderException("invalid_range", "Use one explicit byte range of at most 1 MiB.", 416);
            var selected = parsed.Ranges.Single();
            if (selected.From is null) throw new CoreProviderException("invalid_range", "Use an explicit starting byte offset.", 416);
            offset = selected.From.Value; end = selected.To ?? Math.Min(size - 1, offset + 1024 * 1024 - 1);
        }
        if (!string.IsNullOrEmpty(range) && size == 0 || offset < 0 || size > 0 && (offset >= size || end < offset || end >= size) || end - offset + 1 > 1024 * 1024)
            throw new CoreProviderException("invalid_range", "Use a valid byte range of at most 1 MiB.", 416);
        var length = checked((int)(end - offset + 1));
        var bytes = await providers.SendBytesAsync(caller, handle.Input.Entry.Conversation.Provider,
            new CoreHistoryAttachmentRead(handle.Input.Entry, handle.Input.AttachmentId, handle.Input.Revision, offset, length), ct);
        if (bytes.Length != length) throw Invalid();
        return new(bytes, handle.Metadata, offset);
    }
    private static void RequireAttachment(HostyHistoryEntry entry, CoreHistoryAttachmentResolve input)
    {
        if (!entry.Data.TryGetProperty("parts", out var parts) || !parts.EnumerateArray().Any(p =>
            p.TryGetProperty("type", out var type) && type.GetString() == "attachment"
            && p.TryGetProperty("attachmentId", out var id) && id.GetString() == input.AttachmentId
            && p.TryGetProperty("revision", out var revision) && revision.GetString() == input.Revision))
            throw new CoreProviderException("not_found", "The current authorized entry does not disclose this attachment revision.", 404);
    }
}

internal sealed partial class CoreProviderMediation
{
    internal async Task<byte[]> SendBytesAsync(CoreCapabilityCaller caller, HostyProviderRef provider, CoreHistoryAttachmentRead input, CancellationToken ct)
    {
        var policy = CoreProviderPolicy.For("conversation-history", "attachments.content");
        var body = JsonSerializer.SerializeToUtf8Bytes(input, CoreJson.TypeInfo<CoreHistoryAttachmentRead>());
        var binding = await IssueAsync(caller, provider, policy, "POST", "/attachments/content", body,
            [input.Entry.Conversation.Id, input.Entry.Id, input.AttachmentId], ct);
        using var request = new HttpRequestMessage(HttpMethod.Post, binding.Descriptor.Url!.TrimEnd('/') + "/attachments/content");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", binding.Token);
        request.Content = new ByteArrayContent(body); request.Content.Headers.ContentType = new("application/json");
        try
        {
            using var response = await clients.CreateClient(ClientName).SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            var bytes = await ReadBoundedAsync(response.Content, ct);
            if (!response.IsSuccessStatusCode) throw new CoreProviderException(response.StatusCode == System.Net.HttpStatusCode.NotFound ? "not_found" : "provider_failed", "The source did not authorize or supply this attachment range.", (int)response.StatusCode);
            var fresh = await authorization.RevalidateAsync(caller.Authority!, caller.User.Id, caller.PrincipalId, policy.Kind, provider.AppId, provider.Key, policy.ToolName, ct);
            policy.Require(fresh); return bytes;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        { throw new CoreProviderException("provider_unavailable", "The attachment source is unavailable.", 503, true); }
    }
}
