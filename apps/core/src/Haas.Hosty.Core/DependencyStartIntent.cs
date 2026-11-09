namespace Haas.Hosty.Core;

// Private registry state, never part of AppSummary. References and hashes are not bearer credentials.
internal sealed record DependencyStartAuthority(string Kind, string? UserId = null, string? CredentialHash = null,
    string? CallerAppId = null, AssistantMcpClaims? Assistant = null, IReadOnlyList<string>? ProviderIds = null);
internal sealed record DependencyStartAttempt(string AppId, DateTimeOffset? Installation, string? StopVersion,
    bool Attempted = false, string? Error = null);
internal sealed record DependencyStartIntent(string Id, DependencyStartAuthority Authority,
    IReadOnlyList<DependencyStartAttempt> Providers);
