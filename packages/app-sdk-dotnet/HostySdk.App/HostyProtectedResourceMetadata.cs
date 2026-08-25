using System.Text.Json.Serialization;

namespace HostySdk.App;

/// <summary>
/// The resource-server half of the MCP authorization handshake (RFC 9728) for an app's MCP
/// endpoint: the metadata document naming Hosty Core as the authorization server, and the 401
/// challenge header pointing at it.
/// </summary>
/// <remarks>
/// The app serves the <em>pointer</em>; Core serves everything else. An app never mints, validates,
/// or even sees an OAuth exchange — a client that follows this pointer comes back carrying an
/// ordinary scoped access token, validated through <see cref="HostyScopedTokenClient"/> exactly as
/// if the operator had pasted one by hand. <see cref="TryBuild"/> answers null in the ordinary
/// state of an app that is not published to a public origin: no metadata simply means the manual
/// token path, which always works.
/// </remarks>
public static class HostyProtectedResourceMetadata
{
    /// <summary>
    /// Builds the metadata for this app's MCP endpoint, or null when the environment cannot name
    /// the two URLs it consists of. A wrong resource identity would have clients requesting tokens
    /// for a URL nothing serves, so nothing here is guessed.
    /// </summary>
    /// <param name="resourceUrl">The MCP endpoint URL as clients reach it; defaults to the
    /// <c>HOSTY_PUBLIC_ORIGIN_API</c> origin plus <paramref name="resourcePath"/>.</param>
    /// <param name="resourcePath">The endpoint's path under the public origin.</param>
    /// <param name="authorizationServerOrigin">Core's browser-reachable origin; defaults to
    /// <c>HOSTY_CORE_PUBLIC_ORIGIN</c>. Never the loopback origin this app dials Core on — the flow
    /// is completed by a remote client and a browser.</param>
    public static HostyResourceMetadata? TryBuild(
        string? resourceUrl = null,
        string resourcePath = "/api/mcp",
        string? authorizationServerOrigin = null)
    {
        var core = Trimmed(authorizationServerOrigin) ?? Trimmed(Environment.GetEnvironmentVariable("HOSTY_CORE_PUBLIC_ORIGIN"));
        var publicOrigin = Trimmed(Environment.GetEnvironmentVariable("HOSTY_PUBLIC_ORIGIN_API"));
        var resource = Trimmed(resourceUrl) ?? (publicOrigin is null ? null : $"{publicOrigin.TrimEnd('/')}{resourcePath}");
        if (core is null || resource is null)
        {
            return null;
        }

        return new HostyResourceMetadata(
            Resource: resource,
            AuthorizationServers: [core.TrimEnd('/')],
            ScopesSupported: [HostyScopedTokenClient.McpReadScope],
            BearerMethodsSupported: ["header"]);
    }

    /// <summary>The <c>WWW-Authenticate</c> value a 401 from the MCP endpoint should carry. The
    /// metadata URL is the RFC 9728 derivation: the well-known prefix inserted before the
    /// resource's path.</summary>
    public static string BuildWwwAuthenticate(HostyResourceMetadata metadata)
    {
        var resource = new Uri(metadata.Resource);
        var origin = $"{resource.Scheme}://{resource.Authority}";
        return $"Bearer resource_metadata=\"{origin}/.well-known/oauth-protected-resource{resource.AbsolutePath.TrimEnd('/')}\"";
    }

    private static string? Trimmed(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

/// <summary>The RFC 9728 document for one MCP endpoint, shaped for direct serialization.</summary>
public sealed record HostyResourceMetadata(
    [property: JsonPropertyName("resource")] string Resource,
    [property: JsonPropertyName("authorization_servers")] IReadOnlyList<string> AuthorizationServers,
    [property: JsonPropertyName("scopes_supported")] IReadOnlyList<string> ScopesSupported,
    [property: JsonPropertyName("bearer_methods_supported")] IReadOnlyList<string> BearerMethodsSupported);
