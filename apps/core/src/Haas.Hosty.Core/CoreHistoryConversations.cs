using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreConversationSource(HostyProviderRef Provider, string? Cursor, bool Done,
    string? SnapshotId, string? HighWater, CoreHistoryProviderCoverage Coverage, DateTimeOffset? LastUpdatedAt = null, string? LastId = null, int? PageSize = null);
internal sealed record CoreConversationPage(HostyConversation[] Conversations, string? NextCursor,
    HostyHistoryCoverage Coverage, CoreHistoryProviderCoverage[] Providers);

internal sealed partial class CoreHistoryAdapter
{
    internal async Task<CoreConversationPage> ConversationsAsync(CoreCapabilityCaller caller, CoreConversationQuery input,
        CoreHistoryCursorStore cursors, CancellationToken ct)
    {
        CoreHistoryValidation.Page(input.Limit, input.Cursor);
        if (input.Providers is not { Length: > 0 and <= 8 } || input.Title?.Length > 512)
            throw CoreHistoryValidation.Input("Select 1–8 explicit providers and a title filter of at most 512 characters.");
        foreach (var provider in input.Providers) CoreProviderMediation.ValidateReference(provider);
        var selected = input.Providers.Distinct().OrderBy(ProviderKey, StringComparer.Ordinal).ToArray();
        var fingerprint = SandboxValidation.Hash("conversations|" + CoreJson.Text(input with { Providers = selected, Cursor = null }));
        var previous = input.Cursor is null ? null : await cursors.ReadAsync(caller, input.Cursor, fingerprint, ct);
        var sources = previous?.ConversationSources?.ToList() ?? selected.Select(p => new CoreConversationSource(p, null, false, null, null, new(p, "complete"))).ToList();
        if (sources.Any(s => s.Cursor is not null && s.PageSize is null))
            throw new CoreProviderException("cursor_expired", "Restart enumeration to establish each provider's stable query.", 410);
        var conversations = new List<HostyConversation>(); var changed = false; var calls = 0; var pageFull = false;
        for (var i = 0; i < sources.Count && conversations.Count < input.Limit && calls < 16 && !pageFull; i++)
        {
            while (!sources[i].Done && conversations.Count < input.Limit && calls < 16)
            {
                var source = sources[i];
                var pageSize = source.PageSize ?? input.Limit - conversations.Count;
                // A source cursor binds its original query, including page size. End this aggregate
                // page early rather than changing that query or retaining provider-owned content.
                if (pageSize > input.Limit - conversations.Count) { pageFull = true; break; }
                try
                {
                    var query = new CoreConversationSourceQuery(source.Provider, input.Title, source.Cursor, pageSize);
                    var raw = await Send(caller, source.Provider, "conversations.query", "POST", "/conversations/query", query, [], null, ct); calls++;
                    var page = raw.Deserialize(CoreJson.TypeInfo<HostyConversationPage>()) ?? throw Invalid();
                    if (page.Conversations is null || page.Conversations.Length > query.Limit || page.NextCursor?.Length > 16384
                        || page.NextCursor is not null && (page.NextCursor == source.Cursor || page.Conversations.Length == 0)
                        || string.IsNullOrEmpty(page.SnapshotId) || page.SnapshotId.Length > 256
                        || source.SnapshotId is not null && (source.SnapshotId != page.SnapshotId || source.HighWater != page.HighWater)
                        || page.Conversations.Select(c => c.Ref).Distinct().Count() != page.Conversations.Length) throw Invalid();
                    CoreHistoryValidation.Coverage(page.Coverage); CoreAgentSessionAdapter.Revision(page.HighWater);
                    var lastAt = source.LastUpdatedAt; var lastId = source.LastId;
                    foreach (var conversation in page.Conversations)
                    {
                        CoreHistoryValidation.Metadata(conversation, source.Provider);
                        if (lastAt is { } at && (conversation.UpdatedAt > at || conversation.UpdatedAt == at
                            && string.CompareOrdinal(conversation.Ref.Id, lastId) <= 0)) throw Invalid();
                        lastAt = conversation.UpdatedAt; lastId = conversation.Ref.Id;
                    }
                    foreach (var conversation in page.Conversations)
                    {
                        try
                        {
                            var current = (await ConversationAsync(caller, conversation.Ref, ct)).Deserialize(CoreJson.TypeInfo<HostyConversation>())!;
                            if (current.Revision != conversation.Revision || input.Title is not null && !Fold(current.Title ?? "").Contains(Fold(input.Title), StringComparison.Ordinal)) { changed = true; continue; }
                            conversations.Add(current);
                        }
                        catch (CoreProviderException ex) when (ex.Status is 403 or 404 or 409 or 410) { changed = true; }
                    }
                    sources[i] = source with { Cursor = page.NextCursor, Done = page.NextCursor is null, SnapshotId = page.SnapshotId,
                        HighWater = page.HighWater, Coverage = new(source.Provider, page.Coverage.State), LastUpdatedAt = lastAt, LastId = lastId, PageSize = pageSize };
                }
                catch (Exception ex) when (ex is CoreProviderException or AppIdentityException)
                {
                    sources[i] = source with { Done = true, Coverage = new(source.Provider, "unavailable",
                        ex is CoreProviderException e ? e.Error : new("permission_denied", "Provider access is unavailable.", false)) };
                }
            }
        }
        var next = sources.Any(s => !s.Done)
            ? await cursors.SaveAsync(caller, fingerprint, [], previous?.ExpiresAt ?? clock.UtcNow.AddMinutes(15), ct, sources.ToArray()) : null;
        var partial = changed || calls >= 16 || sources.Any(s => s.Coverage.State != "complete");
        return new(conversations.ToArray(), next, new(partial ? "partial" : "complete", partial ? ["Source access, content, coverage or the bounded enumeration budget changed; continue or start a fresh query as appropriate."] : []), sources.Select(s => s.Coverage).ToArray());
    }
}
