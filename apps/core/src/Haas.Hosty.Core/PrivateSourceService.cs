using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using Microsoft.AspNetCore.WebUtilities;

namespace Haas.Hosty.Core;

// Only references cross the review/persistence boundary. Tokens stay inside UserConnectionService.
internal sealed record SourceReadGrant(string OwnerId, string ConnectionId, string Provider,
    string AccountName, string Label, string Repository, string? ManifestUrl = null);
internal sealed record PrivateSourceAccess(SourceReadGrant? Manifest = null, SourceReadGrant? Git = null);
internal sealed record PrivateSourceChoice(string? ManifestConnectionId = null, string? GitConnectionId = null);

internal sealed class PrivateSourceService(UserConnectionService connections, HttpClient http)
{
    internal static AppLifecycleException Denied(string message = "Private source access is unavailable. Reconnect in your profile, then review the app's source connections.")
        => new("source_access_required", message);

    public async Task<SourceReadGrant> BindAsync(string owner, string id, string url, bool manifest, CancellationToken ct)
    {
        var resource = manifest ? ParseManifest(url).Repository : NormalizeRepository(url);
        return await UseAsync(owner, id, connection =>
        {
            ValidateProvider(connection, resource);
            return Task.FromResult(new SourceReadGrant(owner, id, connection.Provider,
                connection.AccountName, connection.Label, resource, manifest ? url : null));
        }, ct);
    }

    public async Task ValidateAsync(PrivateSourceAccess? access, CancellationToken ct)
    {
        foreach (var grant in new[] { access?.Manifest, access?.Git }.OfType<SourceReadGrant>())
            await UseGrantAsync(grant, _ => Task.FromResult(true), ct);
    }

    public async Task<byte[]> ReadAsync(SourceReadGrant grant, string url, long limit, CancellationToken ct)
    {
        var resource = ParseManifest(url);
        if (resource.Repository != grant.Repository || grant.ManifestUrl != url)
            throw Denied("The manifest resource changed. Select its connection and review it again.");
        return await ReadContentAsync(grant, resource, limit, ct);
    }

    public async Task<byte[]?> ReadAssetAsync(SourceReadGrant grant, string relative, long limit, CancellationToken ct)
    {
        try
        {
            if (relative.StartsWith('/') || relative.Contains('\\') || relative.Split('/').Any(p => p is ".." or ".") || Uri.TryCreate(relative, UriKind.Absolute, out _)) return null;
            var file = ParseManifest(grant.ManifestUrl!);
            var slash = file.Path.LastIndexOf('/');
            return await ReadContentAsync(grant, file with { Path = (slash < 0 ? "" : file.Path[..(slash + 1)]) + relative }, limit, ct);
        }
        catch (AppLifecycleException) { return null; }
    }

    private Task<byte[]> ReadContentAsync(SourceReadGrant grant, RepositoryFile file, long limit, CancellationToken ct)
        => UseGrantAsync(grant, async connection =>
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            using var request = new HttpRequestMessage(HttpMethod.Get, file.ApiUrl);
            request.Headers.Authorization = Header(connection, git: false);
            request.Headers.UserAgent.ParseAdd("Hosty/1.0");
            request.Headers.Accept.ParseAdd(connection.Provider == "github" ? "application/vnd.github.raw+json" : "application/octet-stream");
            try
            {
                using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                if (!response.IsSuccessStatusCode) throw Denied($"Private source read failed (HTTP {(int)response.StatusCode}). Check the selected account and repository access.");
                if (response.Content.Headers.ContentLength > limit) throw Denied("Private source file exceeds its size limit.");
                await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
                using var output = new MemoryStream();
                var buffer = new byte[16384];
                int count;
                while ((count = await stream.ReadAsync(buffer, timeout.Token)) != 0)
                {
                    if (output.Length + count > limit) throw Denied("Private source file exceeds its size limit.");
                    output.Write(buffer, 0, count);
                }
                return output.ToArray();
            }
            catch (HttpRequestException) { throw Denied("The private source provider could not be reached."); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw Denied("The private source read timed out."); }
        }, ct);

    // A grant authorizes one HTTPS repository. Fetch by explicit URL, never by checkout remotes.
    // Config is process-local; neither the command line nor .git/config contains the credential.
    public Task<string> GitAsync(SourceReadGrant grant, string repository, string? directory, IReadOnlyList<string> args, CancellationToken ct)
    {
        if (NormalizeRepository(repository) != grant.Repository) throw Denied("The Git repository changed. Review its connection again.");
        return UseGrantAsync(grant, async connection =>
        {
            if (directory is not null) await ValidateGitConfigAsync(directory, grant.Repository, ct);
            var start = AppSourceService.CreateGitStartInfo(directory, args);
            ConfigureGit(start, grant.Repository, Header(connection, git: true).ToString());
            ProcessRunResult result;
            try { result = await ProcessRunner.RunAsync(start, TimeSpan.FromMinutes(10), ct, 256 * 1024); }
            catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
            { throw Denied("Git is unavailable for private source reads."); }
            if (result.TimedOut || result.ExitCode != 0) throw Denied("Private Git read failed. Check the connection, repository access and network, then retry.");
            return result.StandardOutput.Trim();
        }, ct);
    }

    internal static async Task ValidateGitConfigAsync(string directory, string repository, CancellationToken ct)
    {
        // Repository-local helpers/includes/URL rewrites can execute commands or change credential
        // routing. Refuse them before the credential enters a child environment; never rewrite a
        // user's configuration to make a private read succeed. Config inspection executes no hooks.
        var inspect = AppSourceService.CreateGitStartInfo(directory, ["config", "--local", "--no-includes", "--name-only", "--list"]);
        ConfigureGit(inspect, repository, "");
        var config = await ProcessRunner.RunAsync(inspect, TimeSpan.FromSeconds(10), ct, 64 * 1024);
        if (config.ExitCode != 0 || config.TimedOut || config.StandardOutput.Length >= 64 * 1024)
            throw Denied("Could not verify repository transport configuration before a private read.");
        foreach (var key in config.StandardOutput.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var name = key.ToLowerInvariant();
            if (name.StartsWith("http.", StringComparison.Ordinal) || name.StartsWith("credential.", StringComparison.Ordinal) ||
                name.StartsWith("url.", StringComparison.Ordinal) || name.StartsWith("include.", StringComparison.Ordinal) ||
                name.StartsWith("includeif.", StringComparison.Ordinal) || name.StartsWith("filter.", StringComparison.Ordinal) ||
                name is "extensions.worktreeconfig" or "core.fsmonitor" or "core.hookspath")
                throw Denied("The checkout contains local transport or execution overrides. Remove those overrides before using a personal source connection.");
        }
    }

    internal static void ConfigureGit(ProcessStartInfo start, string repository, string authorization)
    {
        // Suppress operator helpers, URL rewrites and tracing. Local repository config is overridden
        // for credentials/transport; authentication is URL-scoped and redirects are disabled.
        foreach (var key in start.Environment.Keys.Where(key => key.StartsWith("GIT_", StringComparison.Ordinal)).ToArray()) start.Environment.Remove(key);
        start.Environment["GIT_CONFIG_NOSYSTEM"] = "1";
        start.Environment["GIT_CONFIG_GLOBAL"] = OperatingSystem.IsWindows() ? "NUL" : "/dev/null";
        start.Environment["GIT_TERMINAL_PROMPT"] = "0";
        start.Environment["GIT_ASKPASS"] = "";
        start.Environment["GCM_INTERACTIVE"] = "never";
        (string Key, string Value)[] config = [
            ("credential.helper", ""), ("http.extraHeader", ""),
            ($"http.{repository}.extraHeader", "Authorization: " + authorization),
            ("http.followRedirects", "false"), ("protocol.allow", "never"),
            ("protocol.https.allow", "always"), ("http.sslVerify", "true"),
            ("submodule.recurse", "false"), ("fetch.recurseSubmodules", "false"),
            ("core.hooksPath", OperatingSystem.IsWindows() ? "NUL" : "/dev/null"), ("core.fsmonitor", "false")];
        start.Environment["GIT_CONFIG_COUNT"] = config.Length.ToString(System.Globalization.CultureInfo.InvariantCulture);
        for (var i = 0; i < config.Length; i++)
        {
            start.Environment[$"GIT_CONFIG_KEY_{i}"] = config[i].Key;
            start.Environment[$"GIT_CONFIG_VALUE_{i}"] = config[i].Value;
        }
    }

    private Task<T> UseGrantAsync<T>(SourceReadGrant grant, Func<UserProviderConnection, Task<T>> action, CancellationToken ct)
        => UseAsync(grant.OwnerId, grant.ConnectionId, connection =>
        {
            ValidateProvider(connection, grant.Repository);
            if (connection.Provider != grant.Provider) throw Denied();
            return action(connection);
        }, ct);

    private async Task<T> UseAsync<T>(string owner, string id, Func<UserProviderConnection, Task<T>> action, CancellationToken ct)
    {
        try { return await connections.UseForSourceAsync(owner, id, action, ct); }
        catch (UserConnectionException) { throw Denied(); }
    }

    private static AuthenticationHeaderValue Header(UserProviderConnection c, bool git)
        => c.Provider == "azure-devops" && c.Method == "pat" || git && c.Provider == "github"
            ? new("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes((c.Provider == "github" ? "x-access-token" : "") + ":" + c.AccessToken)))
            : new("Bearer", c.AccessToken);

    private static void ValidateProvider(UserProviderConnection c, string repository)
    {
        var uri = new Uri(repository);
        if (c.Provider == "github" && uri.Host == "github.com") return;
        if (c.Provider == "azure-devops" && uri.Host == "dev.azure.com" &&
            uri.AbsolutePath.Split('/')[1].Equals(c.Organization, StringComparison.OrdinalIgnoreCase)) return;
        throw Denied("The connection does not belong to this source provider or Azure DevOps organization.");
    }

    internal static string NormalizeRepository(string value)
    {
        var uri = SafeUri(value);
        var parts = Parts(uri);
        if (uri.Host == "github.com" && parts.Length == 2)
            return $"https://github.com/{parts[0].ToLowerInvariant()}/{parts[1].TrimEnd('/').RemoveGitSuffix().ToLowerInvariant()}.git";
        if (uri.Host == "dev.azure.com" && parts.Length == 4 && parts[2] == "_git")
            return $"https://dev.azure.com/{parts[0].ToLowerInvariant()}/{Uri.EscapeDataString(parts[1])}/_git/{Uri.EscapeDataString(parts[3])}";
        throw Denied("Choose a GitHub or Azure DevOps HTTPS repository URL without credentials or query parameters.");
    }

    internal sealed record RepositoryFile(string Repository, string Path, string Ref, string RefType)
    {
        public string ApiUrl
        {
            get
            {
                var u = new Uri(Repository); var p = Parts(u);
                if (u.Host == "github.com") return $"https://api.github.com/repos/{p[0]}/{p[1].RemoveGitSuffix()}/contents/{string.Join('/', Path.Split('/').Select(Uri.EscapeDataString))}?ref={Uri.EscapeDataString(Ref)}";
                return $"https://dev.azure.com/{p[0]}/{Uri.EscapeDataString(p[1])}/_apis/git/repositories/{Uri.EscapeDataString(p[3])}/items?path={Uri.EscapeDataString('/' + Path)}&versionDescriptor.version={Uri.EscapeDataString(Ref)}&versionDescriptor.versionType={RefType}&download=true&api-version=7.1";
            }
        }
    }

    internal static RepositoryFile ParseManifest(string value)
    {
        var uri = SafeUri(value, query: true); var p = Parts(uri);
        if (uri.Host == "raw.githubusercontent.com" && p.Length >= 4 && uri.Query.Length == 0)
            return new(NormalizeRepository($"https://github.com/{p[0]}/{p[1]}"), string.Join('/', p.Skip(3)), p[2], "branch");
        if (uri.Host == "github.com" && p.Length >= 5 && p[2] == "blob" && uri.Query.Length == 0)
            return new(NormalizeRepository($"https://github.com/{p[0]}/{p[1]}"), string.Join('/', p.Skip(4)), p[3], "branch");
        if (uri.Host == "dev.azure.com" && p.Length == 4 && p[2] == "_git")
        {
            var query = QueryHelpers.ParseQuery(uri.Query);
            if (query.Keys.Any(k => k is not ("path" or "version")) || !query.TryGetValue("path", out var filePath) || filePath.Count != 1 || !query.TryGetValue("version", out var fileVersion) || fileVersion.Count != 1) throw Denied("Azure manifest URLs require path and version (GBbranch, GTtag or GCcommit).");
            var path = filePath.ToString().TrimStart('/'); var version = fileVersion.ToString();
            var type = version.Length > 2 ? version[..2] switch { "GB" => "branch", "GT" => "tag", "GC" => "commit", _ => "" } : "";
            if (type.Length == 0 || string.IsNullOrWhiteSpace(path) || path.Contains('\\') || path.Split('/').Any(s => s is ".." or "." or "")) throw Denied("Invalid Azure manifest file or version.");
            return new(NormalizeRepository(uri.GetLeftPart(UriPartial.Path)), path, version[2..], type);
        }
        throw Denied("Use a GitHub raw/blob file URL, or an Azure repository URL with ?path=/manifest.json&version=GBmain.");
    }

    private static Uri SafeUri(string value, bool query = false)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0 || !query && uri.Query.Length != 0 || value.Contains('\\')) throw Denied("Private source URLs must use HTTPS without embedded credentials.");
        return uri;
    }
    private static string[] Parts(Uri uri)
    {
        var parts = uri.AbsolutePath.Trim('/').Split('/').Select(Uri.UnescapeDataString).ToArray();
        if (parts.Any(p => string.IsNullOrWhiteSpace(p) || p is "." or ".." || p.IndexOfAny(['/', '\\', '?', '#', '\r', '\n']) >= 0)) throw Denied("Invalid source URL path.");
        return parts;
    }
}

internal static class RepositoryNames
{
    internal static string RemoveGitSuffix(this string value) => value.EndsWith(".git", StringComparison.OrdinalIgnoreCase) ? value[..^4] : value;
}
