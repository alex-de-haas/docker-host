// Platform-owned references and minimal execution observations. Providers own native session state.
namespace HostySdk.App;

/// <summary>A provider installation and declared interface key on the connected Core.</summary>
public record HostyProviderRef(string AppId, string InstallationId, string Key);
/// <summary>A provider-owned conversation, distinct from a native session and a run.</summary>
public record HostyConversationRef(HostyProviderRef Provider, string Id);
/// <summary>A provider-native session. Possession of this reference does not grant access.</summary>
public record HostyNativeSessionRef(HostyProviderRef Provider, string Id);
/// <summary>One provider-owned execution attempt, qualified independently of conversation history.</summary>
public record HostyRunRef(HostyProviderRef Provider, string Id);
/// <summary>A bounded execution observation; terminal state never implies confirmed process exit.</summary>
public record HostyAgentRun(HostyRunRef Ref, string Revision, string State, DateTimeOffset ObservedAt,
    string Freshness, bool StopConfirmed, HostyNativeSessionRef? NativeSession = null, HostyConversationRef? Conversation = null);
/// <summary>Public execution metadata, excluding native state, credentials and conversation content.</summary>
public record HostyAgentSession(HostyNativeSessionRef Ref, string Revision, HostyRunRef[] ActiveRuns,
    string[] Capabilities, HostyConversationRef? Conversation = null);
/// <summary>One explicitly selected provider's bounded result, with honest availability.</summary>
public record HostyAgentSessionPage(HostyAgentSession[] Sessions, string? NextCursor, string Availability, DateTimeOffset ObservedAt);
/// <summary>A cancellation receipt; acceptance alone does not establish stop confirmation.</summary>
public record HostyRunCancelReceipt(string RequestId, string State, HostyAgentRun Run);

/// <summary>A current run observation with a subject-bound continuation and explicit rescan marker.</summary>
public record HostyAgentRunNotification(HostyAgentRun Run, string Cursor, bool RescanRequired);

/// <summary>A bounded provider-local session inventory query.</summary>
public record HostyAgentSessionQuery(HostyProviderRef Provider, HostyConversationRef? Conversation = null, string? Cursor = null, int Limit = 50);
/// <summary>A replayable request against the observed execution revision.</summary>
public record HostyRunCancel(HostyRunRef Run, string RequestId, string ExpectedRevision);
/// <summary>A subject-bound, expiring SSE handle and its initial metadata observation.</summary>
public record HostyAgentRunSubscription(string Handle, DateTimeOffset ExpiresAt, HostyAgentRunNotification Initial);
/// <summary>Create or resume a run observation without granting control authority.</summary>
public record HostyAgentRunSubscriptionCreate(HostyRunRef Run, string? Cursor = null);
