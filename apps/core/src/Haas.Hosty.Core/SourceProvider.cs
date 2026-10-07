using System.Net.Http.Headers;

namespace Haas.Hosty.Core;

internal sealed record SourceProviderDescriptor(string Id, string DisplayName, string[] AuthenticationMethods, string[] Capabilities);
internal sealed record SourceRepositoryFile(string Repository, string Path, string Ref, string RefType = "branch");

// Internal Core boundary. Secret-bearing values must never be exposed through app APIs or RPC.
// Core retains ownership, consent, storage, refresh serialization and local Git execution.
internal interface ISourceProvider
{
    SourceProviderDescriptor Descriptor { get; }
    string? ClientId { get; }
    IPublicationProvider? Publication { get; }
    UserConnectionInput Validate(UserConnectionInput input);
    Task<ProviderDevice> StartAsync(UserConnectionInput input, string clientId, CancellationToken ct);
    Task<(ProviderToken? Token, string? Pending)> PollAsync(string clientId, string deviceCode, CancellationToken ct);
    Task<ProviderToken> RefreshAsync(UserProviderConnection connection, CancellationToken ct);
    Task<ProviderIdentity> IdentityAsync(string method, string token, CancellationToken ct);
    bool Owns(Uri uri);
    string NormalizeRepository(string url);
    SourceRepositoryFile ParseManifest(string url);
    HttpRequestMessage FileRequest(UserProviderConnection connection, SourceRepositoryFile file);
    AuthenticationHeaderValue GitAuthorization(UserProviderConnection connection);
}

internal sealed class SourceProviderRegistry(IEnumerable<ISourceProvider> providers)
{
    private readonly IReadOnlyDictionary<string, ISourceProvider> entries = providers.ToDictionary(p => p.Descriptor.Id, StringComparer.Ordinal);
    public SourceProviderDescriptor[] Descriptors => entries.Values.Select(p => p.Descriptor).ToArray();
    public bool Contains(string id) => entries.ContainsKey(id);
    public ISourceProvider Resolve(string? id) => id is not null && entries.TryGetValue(id, out var provider) ? provider
        : throw new UserConnectionException("provider_unsupported", $"Source provider '{id}' is not available. Choose a supported connection or disconnect this account.", 409);
    public ISourceProvider ForUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) throw PrivateSourceService.Denied("Invalid source URL.");
        var matches = entries.Values.Where(p => p.Owns(uri)).ToArray();
        return matches.Length == 1 ? matches[0]
            : throw PrivateSourceService.Denied("This private source provider is not supported. Select a supported repository and connection.");
    }
}
