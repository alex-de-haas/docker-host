using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreHistoryProvider(HostyProviderRef Provider);
internal sealed record CoreConversationQuery(HostyProviderRef[] Providers, string? Title = null, string? Cursor = null, int Limit = 50);
internal sealed record CoreConversationSourceQuery(HostyProviderRef Provider, string? Title = null, string? Cursor = null, int Limit = 50);
internal sealed record CoreConversationGet(HostyConversationRef Conversation);
internal sealed record CoreHistoryQuery(HostyConversationRef Conversation, string[]? Kinds = null, string? Cursor = null, int Limit = 50);
internal sealed record CoreHistoryEntryGet(HostyHistoryEntryRef Entry, string? ExpectedRevision = null);
internal sealed record CoreHistoryShareCreate(HostyConversationRef Ref, string RequestId, string ExpectedRevision,
    HostyHistorySelection Selection, string[] RecipientUserIds, bool IncludeAttachments = false, string[]? Extensions = null,
    string? Label = null, DateTimeOffset? ExpiresAt = null);
internal sealed record CoreHistoryShareRevoke(HostyConversationRef Ref, string GrantId, string RequestId, string ExpectedRevision);
internal sealed record CoreHistorySearch(HostyProviderRef[]? Providers, string Q, string[]? Kinds = null,
    HostyConversationRef[]? Conversations = null, string? Cursor = null, int Limit = 50);
internal sealed record CoreHistorySourceSearch(HostyProviderRef Provider, string Q, string[] Kinds,
    HostyConversationRef[]? Conversations = null, string? Cursor = null, int Limit = 50);
internal sealed record CoreHistorySourceHits(HostyHistorySearchHit[] Hits, string? NextCursor, string SnapshotId,
    string HighWater, HostyHistoryCoverage Coverage);
internal sealed record CoreHistoryProviderCoverage(HostyProviderRef Provider, string State, CoreProviderError? Error = null);
internal sealed record CoreHistorySearchPage(HostyHistorySearchHit[] Hits, string? NextCursor,
    HostyHistoryCoverage Coverage, CoreHistoryProviderCoverage[] Providers);
internal sealed record CoreHistoryAttachmentResolve(HostyHistoryEntryRef Entry, string AttachmentId, string Revision);
internal sealed record CoreHistorySourceAttachment(string AttachmentId, string Revision, string Name, string MediaType, long SizeBytes);
internal sealed record CoreHistoryAttachment(string AttachmentId, string Revision, string Name, string MediaType,
    long SizeBytes, string Handle, DateTimeOffset ExpiresAt);
