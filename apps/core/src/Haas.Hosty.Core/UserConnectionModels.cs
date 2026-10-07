namespace Haas.Hosty.Core;

// Persisted only in Core's owner-only auth state. Never return this record from an endpoint.
internal sealed record UserProviderConnection(string Id, string UserId, string Label, string Provider,
    string Organization, string Tenant, string AccountId, string AccountName, string Method,
    string AccessToken, string? RefreshToken, DateTimeOffset? ExpiresAt, string? ClientId,
    DateTimeOffset CreatedAt, DateTimeOffset? CheckedAt, string Status, string Revision);
internal sealed record UserConnectionSummary(string Id, string Label, string Provider, string Organization,
    string AccountId, string AccountName, string Method, DateTimeOffset? ExpiresAt, DateTimeOffset? CheckedAt, string Status);
internal sealed record UserProfileResponse(string Id, string? Email, string? DisplayName,
    UserConnectionSummary[] Connections, SourceProviderDescriptor[] Providers, PublicationIdentity? GitIdentity = null);
internal sealed record UserProfileUpdate(string DisplayName);
internal sealed record BasicUserProfile(string Id, string? Email, string? DisplayName);
internal sealed record SourceConnectionsResponse(UserConnectionSummary[] Connections, SourceProviderDescriptor[] Providers, PublicationIdentity? GitIdentity);
internal sealed record SourceIdentityUpdate(PublicationIdentity? GitIdentity);
internal sealed record UserConnectionInput(string? Label, string Provider, string? Organization = null,
    string? Tenant = null, string? Token = null, bool PrivateRepositories = false);
internal sealed record UserConnectionRename(string Label);
internal sealed record UserDeviceResponse(string Id, string Status, string? UserCode = null,
    string? VerificationUri = null, DateTimeOffset? ExpiresAt = null, int Interval = 5,
    UserConnectionSummary? Connection = null);
internal sealed record ProviderIdentity(string Id, string Name);
internal sealed record ProviderToken(string AccessToken, string? RefreshToken, DateTimeOffset? ExpiresAt);
internal sealed record ProviderDevice(string DeviceCode, string UserCode, string VerificationUri, int ExpiresIn, int Interval);
internal sealed class UserConnectionException(string code, string message, int status = 400) : Exception(message)
{
    public string Code { get; } = code;
    public int Status { get; } = status;
}
