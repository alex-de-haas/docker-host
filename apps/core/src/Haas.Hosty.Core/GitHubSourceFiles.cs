using System.Net.Http.Headers;
using System.Text;

namespace Haas.Hosty.Core;

internal sealed partial class GitHubSourceProvider
{
    public bool Owns(Uri uri) => uri.Host is "github.com" or "raw.githubusercontent.com";

    public string NormalizeRepository(string value)
    {
        var uri = SafeUri(value);
        var parts = Parts(uri);
        if (uri.Host == "github.com" && parts.Length == 2)
            return $"https://github.com/{parts[0].ToLowerInvariant()}/{parts[1].RemoveGitSuffix().ToLowerInvariant()}.git";
        throw PrivateSourceService.Denied("Choose a GitHub HTTPS repository URL without credentials or query parameters.");
    }

    public SourceRepositoryFile ParseManifest(string value)
    {
        var uri = SafeUri(value); var p = Parts(uri);
        if (uri.Host == "raw.githubusercontent.com" && p.Length >= 4)
            return new(NormalizeRepository($"https://github.com/{p[0]}/{p[1]}"), string.Join('/', p.Skip(3)), p[2]);
        if (uri.Host == "github.com" && p.Length >= 5 && p[2] == "blob")
            return new(NormalizeRepository($"https://github.com/{p[0]}/{p[1]}"), string.Join('/', p.Skip(4)), p[3]);
        throw PrivateSourceService.Denied("Use a GitHub raw/blob file URL.");
    }

    public HttpRequestMessage FileRequest(UserProviderConnection connection, SourceRepositoryFile file)
    {
        var parts = Parts(new Uri(NormalizeRepository(file.Repository)));
        var url = $"https://api.github.com/repos/{parts[0]}/{parts[1].RemoveGitSuffix()}/contents/{string.Join('/', file.Path.Split('/').Select(Uri.EscapeDataString))}?ref={Uri.EscapeDataString(file.Ref)}";
        var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", connection.AccessToken);
        request.Headers.UserAgent.ParseAdd("Hosty/1.0");
        request.Headers.Accept.ParseAdd("application/vnd.github.raw+json");
        return request;
    }

    public AuthenticationHeaderValue GitAuthorization(UserProviderConnection connection)
        => new("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes("x-access-token:" + connection.AccessToken)));

    private static Uri SafeUri(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0 || uri.Query.Length != 0 || value.Contains('\\'))
            throw PrivateSourceService.Denied("Private source URLs must use HTTPS without embedded credentials.");
        return uri;
    }
    private static string[] Parts(Uri uri)
    {
        var parts = uri.AbsolutePath.Trim('/').Split('/').Select(Uri.UnescapeDataString).ToArray();
        if (parts.Any(p => string.IsNullOrWhiteSpace(p) || p is "." or ".." || p.IndexOfAny(['/', '\\', '?', '#', '\r', '\n']) >= 0))
            throw PrivateSourceService.Denied("Invalid source URL path.");
        return parts;
    }
}
