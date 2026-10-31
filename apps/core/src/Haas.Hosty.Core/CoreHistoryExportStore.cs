using System.Collections.Concurrent;
using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreHistoryExportCreate(string RequestId, HostyHistoryExportConsumer Consumer,
    HostyHistoryExportCorpus Corpus, string Purpose, DateTimeOffset? ExpiresAt = null);
internal sealed record CoreHistoryExportGet(string ExportGrantId);
internal sealed record CoreHistoryExportQuery(string ExportGrantId, HostyProviderRef Provider, string? Cursor = null, int Limit = 50);
internal sealed record CoreHistoryExportRevoke(string ExportGrantId, string RequestId, string ExpectedRevision);
internal sealed record CoreHistoryExportAcknowledge(string ExportGrantId, string RequestId, string ExpectedRevision,
    string? LastAppliedCursor = null, bool? PurgeComplete = null);
internal sealed record CoreHistoryExportScope(string GrantId, string Revision, string OwnerUserId,
    HostyProviderRef Provider, string[]? ConversationIds);
internal sealed record CoreHistorySourceExport(CoreHistoryExportScope Scope, string? Cursor = null, int Limit = 50);
internal sealed record CoreHistoryExportCursor(string Id, HostyProviderRef Provider, string Kind, string SourceCursor,
    string Sequence, bool Acknowledgeable, DateTimeOffset? ExpiresAt);
internal sealed record CoreHistoryExportCheckpoint(HostyProviderRef Provider, string Cursor, string Sequence);
internal sealed record CoreHistoryExportReceipt(string RequestId, string UserId, string PrincipalId,
    string Fingerprint, HostyHistoryExportGrant Result);
internal sealed record CoreHistoryExportRecord(HostyHistoryExportGrant Grant, string CreatorPrincipal,
    CoreCallerAuthority CreatorAuthority, string CreateFingerprint, DateTimeOffset CreatedAt,
    string? NonceHash, string? BrowserSessionHash, DateTimeOffset? NonceExpiresAt,
    CoreHistoryExportCursor[] Cursors, CoreHistoryExportCheckpoint[] Checkpoints, CoreHistoryExportReceipt[] Receipts, string? CreatorLabel = null, string? ConsumerLabel = null);

// Consent, exact consumer/corpus bindings, replay and checkpoints only. No history text or provider
// credentials are kept here. The store depends on no dispatcher, avoiding introspection recursion.
internal sealed class CoreHistoryExportStore(CoreDataPaths paths, IClock clock, AuditStore audit)
{
    private readonly SemaphoreSlim creationGate = new(1, 1);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new(StringComparer.Ordinal);
    private string PathFor(string id)
    {
        if (!Guid.TryParseExact(id, "N", out _)) throw Missing();
        var file = Path.Combine(paths.CoreRoot, "history-exports", id + ".json");
        if (CoreDataPaths.ContainsSymbolicLink(paths.DataRoot, file)) throw new CoreProviderException("permission_denied", "Export consent storage changed.", 403);
        return file;
    }
    internal async Task<CoreHistoryExportRecord> ReadAsync(string id, CancellationToken ct)
        => await JsonStorage.ReadAsync<CoreHistoryExportRecord>(PathFor(id), ct) ?? throw Missing();
    internal async Task<CoreHistoryExportRecord> CreateAsync(CoreCapabilityCaller creator, CoreHistoryExportCreate input,
        string consumerPrincipal, string creatorLabel, string consumerLabel, CancellationToken ct)
    {
        var requestId = CoreProviderOperationStore.Normalize(input.RequestId);
        var id = SandboxValidation.Hash(creator.User.Id + "|" + creator.PrincipalId + "|" + requestId)[..32];
        var stamp = SandboxValidation.Hash(CoreJson.Text(input with { RequestId = requestId }));
        var gate = creationGate; await gate.WaitAsync(ct);
        try
        {
            var prior = await JsonStorage.ReadAsync<CoreHistoryExportRecord>(PathFor(id), ct);
            if (prior is not null)
            {
                if (prior.CreateFingerprint != stamp || prior.CreatorPrincipal != creator.PrincipalId || prior.Grant.OwnerUserId != creator.User.Id)
                    throw new CoreProviderException("request_conflict", "This export request UUID already identifies different input.", 409);
                return prior;
            }
            var folder = Path.GetDirectoryName(PathFor(id))!; var active = 0;
            if (Directory.Exists(folder)) foreach (var file in Directory.EnumerateFiles(folder, "*.json"))
            {
                var existing = await ReadAsync(Path.GetFileNameWithoutExtension(file), ct);
                if (existing.Grant.OwnerUserId == creator.User.Id && existing.Grant.State is "proposed" or "active" && (existing.Grant.ExpiresAt is null || existing.Grant.ExpiresAt > clock.UtcNow)) active++;
            }
            if (active >= 100) throw new CoreProviderException("budget_exceeded", "Revoke unused export proposals or grants before creating more.", 429);
            var grant = new HostyHistoryExportGrant(id, "1", "proposed", creator.User.Id, input.Consumer, consumerPrincipal,
                input.Corpus, input.Purpose, input.ExpiresAt, "/account/history-exports/" + id);
            var record = new CoreHistoryExportRecord(grant, creator.PrincipalId, creator.Authority!, stamp, clock.UtcNow, null, null, null, [], [], [], creatorLabel, consumerLabel);
            await JsonStorage.WriteAsync(PathFor(id), record, true, ct); return record;
        }
        finally { gate.Release(); }
    }
    internal async Task<T> ChangeAsync<T>(string id, Func<CoreHistoryExportRecord, Task<(CoreHistoryExportRecord Record, T Result)>> action, CancellationToken ct)
    {
        var gate = gates.GetOrAdd(id, _ => new(1, 1)); await gate.WaitAsync(ct);
        try
        {
            var current = await ReadAsync(id, ct); var result = await action(current);
            if (result.Record != current) await JsonStorage.WriteAsync(PathFor(id), result.Record, true, ct);
            return result.Result;
        }
        finally { gate.Release(); }
    }
    internal static CoreProviderException Missing() => new("not_found", "Export consent not found.", 404);
    internal static bool IsConsumer(CoreHistoryExportRecord record, CoreCapabilityCaller caller)
        => record.Grant.OwnerUserId == caller.User.Id && record.Grant.PrincipalId == caller.PrincipalId;
    internal static string Next(string revision) => (System.Numerics.BigInteger.Parse(revision, System.Globalization.CultureInfo.InvariantCulture) + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
    internal static HostyProviderRef[] Providers(CoreHistoryExportRecord record)
        => record.Grant.Corpus!.Mode == "all-owned" ? record.Grant.Corpus.Providers! : record.Grant.Corpus.Conversations!.Select(c => c.Provider).Distinct().ToArray();
    internal CoreHistoryExportScope Scope(CoreHistoryExportRecord record, HostyProviderRef provider)
    {
        if (record.Grant.State != "active" || record.Grant.ExpiresAt <= clock.UtcNow || !Providers(record).Contains(provider))
            throw new CoreProviderException("permission_denied", "This exact export consumer and source corpus are not currently approved.", 403);
        return new(record.Grant.Id, record.Grant.Revision, record.Grant.OwnerUserId!, provider,
            record.Grant.Corpus!.Mode == "all-owned" ? null : record.Grant.Corpus.Conversations!.Where(c => c.Provider == provider).Select(c => c.Id).ToArray());
    }
    internal static HostyHistoryExportGrant Public(CoreHistoryExportRecord record, CoreCapabilityCaller caller)
        => IsConsumer(record, caller) && record.Grant.State is "purge_required" or "purged"
            ? new(record.Grant.Id, record.Grant.Revision, record.Grant.State) : record.Grant;
    internal static CoreHistoryExportRecord Purge(CoreHistoryExportRecord record)
        => record.Grant.State is "purge_required" or "purged" ? record : record with
        { Grant = record.Grant with { State = "purge_required", Revision = Next(record.Grant.Revision), ApprovalUrl = null }, Cursors = [], NonceHash = null, BrowserSessionHash = null, NonceExpiresAt = null };
    internal async Task<(CoreHistoryExportRecord Record, string Nonce)> NonceAsync(string id, string owner, string sessionHash, CancellationToken ct)
        => await ChangeAsync(id, record =>
        {
            if (record.Grant.OwnerUserId != owner) throw Missing();
            var nonce = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
            record = record with { NonceHash = SandboxValidation.Hash(nonce), BrowserSessionHash = sessionHash, NonceExpiresAt = clock.UtcNow.AddMinutes(10) };
            return Task.FromResult((record, (record, nonce)));
        }, ct);
    internal async Task<HostyHistoryExportGrant> DecideAsync(string id, string owner, string sessionHash, string nonce, string expectedRevision,
        bool approve, Func<CoreHistoryExportRecord, Task> revalidate, CancellationToken ct)
        => await ChangeAsync(id, async record =>
        {
            if (record.Grant.OwnerUserId != owner) throw Missing();
            if (record.Grant.Revision != expectedRevision || record.NonceHash is null || record.NonceHash != SandboxValidation.Hash(nonce)
                || record.BrowserSessionHash != sessionHash || record.NonceExpiresAt <= clock.UtcNow)
                throw new CoreProviderException("revision_conflict", "Open the current export review page and decide again.", 409);
            if (approve)
            {
                if (record.Grant.State != "proposed") throw new CoreProviderException("revision_conflict", "This export request already has a decision.", 409);
                await revalidate(record);
                record = record with { Grant = record.Grant with { State = "active", Revision = Next(record.Grant.Revision), ApprovalUrl = null } };
            }
            else record = Purge(record);
            await audit.AppendAsync(new AuditRecord($"audit_{Guid.NewGuid():N}", "history.export.approval", "history-export", id,
                approve ? "approved" : "revoked", owner, clock.UtcNow, new Dictionary<string, string>
                { ["revision"] = record.Grant.Revision, ["consumerKind"] = record.Grant.Consumer!.Kind, ["consumerAppId"] = record.Grant.Consumer.AppId ?? "", ["corpusDigest"] = SandboxValidation.Hash(CoreJson.Text(record.Grant.Corpus)) }), ct);
            record = record with { NonceHash = null, BrowserSessionHash = null, NonceExpiresAt = null };
            return (record, record.Grant);
        }, ct);
}
