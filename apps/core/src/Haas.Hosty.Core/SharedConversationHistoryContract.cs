using System.Text.Json;
using System.Text.Json.Serialization;

namespace HostySdk.App;

/// <summary>A source entry identity; references carry no read or execution authority.</summary>
public record HostyHistoryEntryRef(HostyConversationRef Conversation, string Id);
/// <summary>Explicitly incomplete historical material is never advertised as complete native state.</summary>
public record HostyHistoryCoverage(string State, string[] Reasons);
/// <summary>Current metadata for the caller's permitted conversation projection.</summary>
public record HostyConversation(HostyConversationRef Ref, string Revision, string? Title, string OwnerUserId,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, string[] Capabilities, HostyNativeSessionRef[]? NativeSessions = null)
{
    /// <summary>Additive v1 provider metadata remains inert and survives Core relay.</summary>
    [JsonExtensionData] public Dictionary<string, JsonElement>? Additional { get; set; }
}
/// <summary>Public attribution for one entry, without credentials or hidden native state.</summary>
public record HostyHistoryActor(string Kind, string? Id = null, string? DisplayName = null);
/// <summary>A revisioned entry. Data is a version-one kind-tagged message/tool/run/usage/extension envelope.
/// JSON retains unknown optional fields and declared inert extension payloads across provider boundaries.</summary>
public record HostyHistoryEntry(HostyHistoryEntryRef Ref, string Revision, string Sequence,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, HostyHistoryActor Actor, JsonElement Data,
    HostyRunRef? Run = null, string? ParentEntryId = null)
{
    /// <summary>Additive v1 envelope fields remain inert and survive Core relay.</summary>
    [JsonExtensionData] public Dictionary<string, JsonElement>? Additional { get; set; }
}
/// <summary>A provider-declared namespaced extension schema; never executable content.</summary>
public record HostyHistoryExtension(string Name, int Version, JsonElement Schema);
/// <summary>Negotiated entry kinds, extension versions and bounded paging/change retention.</summary>
public record HostyHistoryCapabilities(int Version, string[] EntryKinds, HostyHistoryExtension[] Extensions,
    int MaxPageSize, int SnapshotLifetimeSeconds, int ChangeRetentionSeconds);
/// <summary>A stable bounded metadata page with current access checks.</summary>
public record HostyConversationPage(HostyConversation[] Conversations, string? NextCursor, string SnapshotId,
    string HighWater, HostyHistoryCoverage Coverage);
/// <summary>A bounded entry snapshot; permissions remain current on every page.</summary>
public record HostyHistoryPage(HostyHistoryEntry[] Entries, string? NextCursor, string SnapshotId,
    string HighWater, HostyHistoryCoverage Coverage);
/// <summary>A source-cited lexical hit with a bounded excerpt and current source revision.</summary>
public record HostyHistorySearchHit(HostyHistoryEntryRef Entry, string Revision, string? ConversationTitle,
    string Excerpt, DateTimeOffset UpdatedAt, DateTimeOffset ObservedAt);
/// <summary>Fixed selected membership or an explicitly future-inclusive whole conversation.</summary>
public record HostyHistorySelection(string[]? EntryIds = null, bool? IncludeFutureEntries = null);
/// <summary>A provider-owned read-only share to named existing users of this Core.</summary>
public record HostyHistoryShare(string Id, HostyConversationRef Ref, string Revision, string OwnerUserId,
    string[] RecipientUserIds, HostyHistorySelection Selection, bool IncludeAttachments, string[] Extensions,
    string? Label, DateTimeOffset? ExpiresAt, string State);
/// <summary>Only the owner sees all grants; a recipient sees only their own projection.</summary>
public record HostyHistorySharePage(HostyHistoryShare[] Shares, string ConversationRevision);
/// <summary>Replayable provider share outcome and its new conversation revision.</summary>
public record HostyHistoryShareReceipt(string RequestId, HostyHistoryShare Grant, string ConversationRevision);

/// <summary>An explicitly approved owned corpus, never conversations shared by somebody else.</summary>
public record HostyHistoryExportCorpus(string Mode, HostyProviderRef[]? Providers = null,
    HostyConversationRef[]? Conversations = null, bool? IncludeFutureConversations = null);
/// <summary>The exact originating client or a reviewed installed consumer.</summary>
public record HostyHistoryExportConsumer(string Kind, string? AppId = null, string? InstallationId = null);
/// <summary>Control metadata. Revoked consumers receive only identity, revision and purge state.</summary>
public record HostyHistoryExportGrant(string Id, string Revision, string State, string? OwnerUserId = null,
    HostyHistoryExportConsumer? Consumer = null, string? PrincipalId = null, HostyHistoryExportCorpus? Corpus = null,
    string? Purpose = null, DateTimeOffset? ExpiresAt = null, string? ApprovalUrl = null, string? LastAppliedCursor = null);
/// <summary>Source-owned initial enumeration and its change-feed high-water boundary.</summary>
public record HostyHistoryExportSnapshot(HostyHistoryEntry[] Entries, string? NextCursor, string SnapshotId,
    string HighWater, string ChangeCursor, HostyHistoryCoverage Coverage);
/// <summary>A complete replacement, content-free deletion, or explicit partition invalidation.</summary>
public record HostyHistoryChange(string Id, string Sequence, string Type, HostyHistoryEntry? Entry = null,
    HostyHistoryEntryRef? Ref = null, string? Revision = null, string? Reason = null);
/// <summary>At-least-once source changes; consumers deduplicate by source identity and revision.</summary>
public record HostyHistoryChangePage(HostyHistoryChange[] Changes, string NextCursor, string HighWater, HostyHistoryCoverage Coverage);
/// <summary>A bounded batch from an exact approved export and provider partition.</summary>
public record HostyHistoryExportQuery(string ExportGrantId, HostyProviderRef Provider, string? Cursor = null, int Limit = 50);
/// <summary>A monotonic consumer checkpoint or confirmation of completed purge.</summary>
public record HostyHistoryExportAcknowledge(string ExportGrantId, string RequestId, string ExpectedRevision,
    string? LastAppliedCursor = null, bool? PurgeComplete = null);

/// <summary>Content-free source entry change requiring a fresh authorized read.</summary>
public sealed record HostyHistoryNotificationChange(string Type, string EntryId, string Revision);
/// <summary>One bounded conversation notification or explicit rescan after a retained gap.</summary>
public sealed record HostyHistoryNotification(HostyConversationRef Conversation, string Revision, string Cursor, HostyHistoryNotificationChange[] Changes, bool RescanRequired);

/// <summary>Explicit sources and bounded continuation for Core conversation discovery.</summary>
public record HostyConversationQuery(HostyProviderRef[] Providers, string? Title = null, string? Cursor = null, int Limit = 50);
/// <summary>The corresponding single-source provider request.</summary>
public record HostySourceConversationQuery(HostyProviderRef Provider, string? Title = null, string? Cursor = null, int Limit = 50);
/// <summary>A common, content-free failure without transport internals.</summary>
public record HostyHistoryError(string Code, string Message, bool Retryable, string? OperationRef = null);
/// <summary>Honest coverage of an explicitly selected source.</summary>
public record HostyHistoryProviderCoverage(HostyProviderRef Provider, string State, HostyHistoryError? Error = null);
/// <summary>A Core aggregate response; source snapshot identities remain inside opaque continuation.</summary>
public record HostyConversationQueryPage(HostyConversation[] Conversations, string? NextCursor, HostyHistoryCoverage Coverage, HostyHistoryProviderCoverage[] Providers);
/// <summary>Authorized entries within one source-owned conversation.</summary>
public record HostyHistoryQuery(HostyConversationRef Conversation, string[]? Kinds = null, string? Cursor = null, int Limit = 50);
/// <summary>Lexical search over explicit source providers or conversations.</summary>
public record HostyHistorySearch(string Q, HostyProviderRef[]? Providers = null, string[]? Kinds = null, HostyConversationRef[]? Conversations = null, string? Cursor = null, int Limit = 50);
/// <summary>Source-cited current hits with source availability and disclosure coverage.</summary>
public record HostyHistorySearchPage(HostyHistorySearchHit[] Hits, string? NextCursor, HostyHistoryCoverage Coverage, HostyHistoryProviderCoverage[] Providers);
/// <summary>Create or resume a conversation notification stream.</summary>
public record HostyHistorySubscriptionCreate(HostyConversationRef Conversation, string? Cursor = null);
/// <summary>A bounded subject-bound SSE subscription.</summary>
public record HostyHistorySubscription(string Handle, DateTimeOffset ExpiresAt, HostyHistoryNotification Initial);
