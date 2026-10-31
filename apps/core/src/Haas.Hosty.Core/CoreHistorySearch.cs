using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreHistoryPendingHit(HostyHistoryEntryRef Entry, string Revision, DateTimeOffset UpdatedAt);
internal sealed record CoreHistorySearchSource(HostyProviderRef Provider, string? Cursor, bool Started, bool Done,
    CoreHistoryPendingHit[] Pending, CoreHistoryProviderCoverage Coverage, string? SnapshotId = null, string? HighWater = null, CoreHistoryPendingHit? LastHit = null);
internal sealed record CoreHistorySearchCursor(string Id, string UserId, string PrincipalId, string Fingerprint,
    DateTimeOffset ExpiresAt, CoreHistorySearchSource[] Sources, CoreConversationSource[]? ConversationSources = null);

// Only continuation references are kept in Core. Excerpts and transcript bytes are fetched from
// the source after current ACL checks, including when a cursor is resumed after a Core restart.
internal sealed class CoreHistoryCursorStore(CoreDataPaths paths, IClock clock)
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new(StringComparer.Ordinal);
    private string PathFor(string user, string id)
    {
        if (!Guid.TryParseExact(id, "N", out _)) throw new CoreProviderException("cursor_expired", "Start a fresh history query.", 410);
        var path = Path.Combine(paths.CoreRoot, "history-cursors", SandboxValidation.Hash(user), id + ".json");
        if (CoreDataPaths.ContainsSymbolicLink(paths.DataRoot, path)) throw new CoreProviderException("permission_denied", "History cursor storage must not contain symbolic links.", 403);
        return path;
    }
    internal async Task<CoreHistorySearchCursor> ReadAsync(CoreCapabilityCaller caller, string id, string fingerprint, CancellationToken ct)
    {
        var value = await JsonStorage.ReadAsync<CoreHistorySearchCursor>(PathFor(caller.User.Id, id), ct);
        if (value is null || value.UserId != caller.User.Id || value.PrincipalId != caller.PrincipalId || value.ExpiresAt <= clock.UtcNow)
            throw new CoreProviderException("cursor_expired", "This history cursor is expired or belongs to another caller. Start a fresh query.", 410);
        if (value.Fingerprint != fingerprint) throw new CoreProviderException("cursor_expired", "The query, providers or filters changed. Start a fresh query.", 410);
        return value;
    }
    internal async Task<string> SaveAsync(CoreCapabilityCaller caller, string fingerprint, CoreHistorySearchSource[] sources, DateTimeOffset expires, CancellationToken ct, CoreConversationSource[]? conversationSources = null)
    {
        var id = Guid.NewGuid().ToString("N"); var path = PathFor(caller.User.Id, id);
        var root = Path.GetDirectoryName(path)!; var gate = gates.GetOrAdd(root, _ => new(1, 1)); await gate.WaitAsync(ct);
        try
        {
            Directory.CreateDirectory(root);
            var live = 0;
            foreach (var file in Directory.EnumerateFiles(root, "*.json"))
            {
                if (CoreDataPaths.ContainsSymbolicLink(paths.DataRoot, file)) throw new CoreProviderException("permission_denied", "History cursor storage changed.", 403);
                var previous = await JsonStorage.ReadAsync<CoreHistorySearchCursor>(file, ct);
                if (previous is not null && previous.ExpiresAt <= clock.UtcNow) File.Delete(file); else live++;
            }
            if (live >= 256) throw new CoreProviderException("budget_exceeded", "Too many live history pages. Wait for an existing snapshot to expire.", 429, true);
            await JsonStorage.WriteAsync(path, new CoreHistorySearchCursor(id, caller.User.Id, caller.PrincipalId, fingerprint, expires, sources, conversationSources), true, ct);
            return id;
        }
        finally { gate.Release(); }
    }
}

internal sealed partial class CoreHistoryAdapter
{
    internal async Task<CoreHistorySearchPage> SearchAsync(CoreCapabilityCaller caller, CoreHistorySearch input,
        CoreHistoryCursorStore cursors, CancellationToken ct)
    {
        CoreHistoryValidation.Page(input.Limit, input.Cursor); ValidateKinds(input.Kinds);
        if (input.Q is null || input.Q.Length > 512 || input.Conversations?.Length > 100) throw CoreHistoryValidation.Input("Use a query up to 512 characters and at most 100 conversation references.");
        var q = Fold(input.Q);
        var terms = q.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Distinct(StringComparer.Ordinal).ToArray();
        if (terms.Length is < 1 or > 16) throw CoreHistoryValidation.Input("Use 1–16 literal search terms.");
        q = string.Join(' ', terms);
        var selected = input.Providers;
        if (selected is null)
            selected = (await ProvidersAsync(caller, ct)).Providers.Where(p => p.Version == 1)
                .Select(p => new HostyProviderRef(p.AppId, p.InstallationId!, p.Key)).ToArray();
        if (selected.Length > 8) throw new CoreProviderException("provider_selection_required", "Select at most eight history providers explicitly.", 400);
        foreach (var provider in selected) CoreProviderMediation.ValidateReference(provider);
        selected = selected.Distinct().OrderBy(ProviderKey, StringComparer.Ordinal).ToArray();
        foreach (var conversation in input.Conversations ?? [])
        {
            CoreHistoryValidation.Conversation(conversation);
            if (!selected.Contains(conversation.Provider)) throw CoreHistoryValidation.Input("Conversation filters must belong to the selected providers.");
        }
        var kinds = (input.Kinds ?? ["message"]).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        var normalized = input with { Providers = selected, Q = q, Kinds = kinds, Cursor = null,
            Conversations = input.Conversations?.OrderBy(c => ProviderKey(c.Provider) + "|" + c.Id, StringComparer.Ordinal).ToArray() };
        var fingerprint = SandboxValidation.Hash(CoreJson.Text(normalized));
        var previous = input.Cursor is null ? null : await cursors.ReadAsync(caller, input.Cursor, fingerprint, ct);
        var expires = previous?.ExpiresAt ?? clock.UtcNow.AddMinutes(15);
        var sources = previous?.Sources.ToList() ?? selected.Select(p => new CoreHistorySearchSource(p, null, false, false, [], new(p, "complete"))).ToList();
        var hits = new List<HostyHistorySearchHit>(); var changed = false; var calls = 0;
        while (hits.Count < input.Limit && calls < 512)
        {
            // Keep one head from each provider before choosing the globally next updatedAt/ref.
            for (var i = 0; i < sources.Count; i++)
            {
                var source = sources[i];
                if (source.Done || source.Pending.Length != 0) continue;
                try
                {
                    var query = new CoreHistorySourceSearch(source.Provider, q, kinds,
                        input.Conversations?.Where(c => c.Provider == source.Provider).ToArray(), source.Cursor, Math.Min(input.Limit, 200));
                    var raw = await Send(caller, source.Provider, "search", "POST", "/search", query, [], null, ct); calls++;
                    var page = raw.Deserialize(CoreJson.TypeInfo<CoreHistorySourceHits>()) ?? throw Invalid();
                    if (page.Hits is null || page.Hits.Length > query.Limit || page.NextCursor?.Length > 16384
                        || source.Started && page.NextCursor is not null && page.NextCursor == source.Cursor) throw Invalid();
                    CoreHistoryValidation.Coverage(page.Coverage); CoreAgentSessionAdapter.Revision(page.HighWater);
                    if (string.IsNullOrEmpty(page.SnapshotId) || page.SnapshotId.Length > 256
                        || source.Started && (source.SnapshotId != page.SnapshotId || source.HighWater != page.HighWater)
                        || page.Hits.Length == 0 && page.NextCursor is not null) throw Invalid();
                    var last = source.LastHit;
                    foreach (var hit in page.Hits)
                    {
                        CoreHistoryValidation.EntryRef(hit.Entry); CoreAgentSessionAdapter.Revision(hit.Revision);
                        if (hit.Entry.Conversation.Provider != source.Provider || hit.Excerpt?.Length > 500
                            || input.Conversations is not null && !input.Conversations.Contains(hit.Entry.Conversation)) throw Invalid();
                        var current = new CoreHistoryPendingHit(hit.Entry, hit.Revision, hit.UpdatedAt);
                        if (last is not null && CompareHits(last, current) >= 0) throw Invalid();
                        last = current;
                    }
                    var pending = page.Hits.Select(h => new CoreHistoryPendingHit(h.Entry, h.Revision, h.UpdatedAt)).ToArray();
                    sources[i] = source with { Started = true, Cursor = page.NextCursor, Done = page.NextCursor is null,
                        Pending = pending, Coverage = new(source.Provider, page.Coverage.State), SnapshotId = page.SnapshotId, HighWater = page.HighWater, LastHit = last };
                }
                catch (Exception ex) when (ex is CoreProviderException or AppIdentityException)
                {
                    var error = ex is CoreProviderException providerError ? providerError.Error : new CoreProviderError("permission_denied", "Provider access is unavailable.", false);
                    sources[i] = source with { Done = true, Pending = [], Coverage = new(source.Provider, error.Code == "unsupported_capability" ? "unsupported" : "unavailable", error) };
                }
            }
            var candidate = sources.Select((s, index) => (Source: s, Index: index)).Where(p => p.Source.Pending.Length > 0)
                .OrderByDescending(p => p.Source.Pending[0].UpdatedAt).ThenBy(p => ProviderKey(p.Source.Provider), StringComparer.Ordinal)
                .ThenBy(p => p.Source.Pending[0].Entry.Conversation.Id, StringComparer.Ordinal).ThenBy(p => p.Source.Pending[0].Entry.Id, StringComparer.Ordinal).FirstOrDefault();
            if (candidate.Source is null)
            {
                if (sources.All(s => s.Done)) break;
                if (++calls >= 512) break;
                continue;
            }
            var next = candidate.Source.Pending[0];
            sources[candidate.Index] = candidate.Source with { Pending = candidate.Source.Pending[1..] };
            try
            {
                // Never return a cached snippet. A changed/deleted/revoked source entry cannot be
                // restored by an older search cursor. The source rechecks selected-entry sharing.
                var entry = (await EntryAsync(caller, new(next.Entry, next.Revision), ct)).Deserialize(CoreJson.TypeInfo<HostyHistoryEntry>())!; calls += 2;
                if (entry.UpdatedAt != next.UpdatedAt) { changed = true; continue; }
                var text = SearchText(entry.Data); var folded = Fold(text);
                if (!kinds.Contains(entry.Data.GetProperty("kind").GetString()!) || !terms.All(folded.Contains)) { changed = true; continue; }
                var metadata = (await ConversationAsync(caller, entry.Ref.Conversation, ct)).Deserialize(CoreJson.TypeInfo<HostyConversation>())!; calls++;
                hits.Add(new(entry.Ref, entry.Revision, metadata.Title, text.Length <= 500 ? text : text[..500], next.UpdatedAt, clock.UtcNow));
            }
            catch (CoreProviderException ex) when (ex.Status is 403 or 404 or 409 or 410) { changed = true; }
            catch (Exception ex) when (ex is CoreProviderException or AppIdentityException)
            {
                changed = true;
                sources[candidate.Index] = sources[candidate.Index] with { Done = true, Pending = [], Coverage = new(candidate.Source.Provider, "unavailable",
                    ex is CoreProviderException e ? e.Error : new("permission_denied", "Provider access is unavailable.", false)) };
            }
        }
        var more = sources.Any(s => !s.Done || s.Pending.Length > 0);
        var cursor = more ? await cursors.SaveAsync(caller, fingerprint, sources.ToArray(), expires, ct) : null;
        var reasons = new List<string>();
        if (changed) reasons.Add("Source content or current access changed while paging.");
        if (sources.Any(s => s.Coverage.State != "complete")) reasons.Add("One or more providers reported incomplete or unavailable coverage.");
        if (calls >= 512) reasons.Add("This page reached its bounded source-read budget; continue with the returned cursor.");
        return new(hits.ToArray(), cursor, new(reasons.Count == 0 ? "complete" : "partial", reasons.ToArray()), sources.Select(s => s.Coverage).ToArray());
    }
    private static int CompareHits(CoreHistoryPendingHit first, CoreHistoryPendingHit second)
    {
        var time = second.UpdatedAt.CompareTo(first.UpdatedAt); if (time != 0) return time;
        var conversation = string.Compare(first.Entry.Conversation.Id, second.Entry.Conversation.Id, StringComparison.Ordinal);
        return conversation != 0 ? conversation : string.Compare(first.Entry.Id, second.Entry.Id, StringComparison.Ordinal);
    }
    internal static string Fold(string value) => value.Normalize(NormalizationForm.FormKC).ToLowerInvariant().Replace("ß", "ss", StringComparison.Ordinal).Replace("ς", "σ", StringComparison.Ordinal);
    private static string ProviderKey(HostyProviderRef provider) => CoreJson.Text(provider);
    internal static string SearchText(JsonElement data)
    {
        if (!data.TryGetProperty("kind", out var kind)) return "";
        if (kind.GetString() == "extension") return data.TryGetProperty("fallbackText", out var fallback) && fallback.ValueKind == JsonValueKind.String ? fallback.GetString()! : "";
        return data.TryGetProperty("parts", out var parts) && parts.ValueKind == JsonValueKind.Array
            ? string.Join('\n', parts.EnumerateArray().Where(p => p.TryGetProperty("type", out var type) && type.GetString() == "text")
                .Select(p => p.GetProperty("text").GetString())) : "";
    }
}
