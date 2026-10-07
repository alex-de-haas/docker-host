using System.Diagnostics;

namespace Haas.Hosty.Core;

// Only references cross the review/persistence boundary. Tokens stay inside UserConnectionService.
internal sealed record SourceReadGrant(string OwnerId, string ConnectionId, string Provider,
    string AccountName, string Label, string Repository, string? ManifestUrl = null);
internal sealed record PrivateSourceAccess(SourceReadGrant? Manifest = null, SourceReadGrant? Git = null);
internal sealed record PrivateSourceChoice(string? ManifestConnectionId = null, string? GitConnectionId = null,
    bool ClearManifestConnection = false, bool ClearGitConnection = false);

internal sealed class PrivateSourceService(UserConnectionService connections, HttpClient http)
{
    internal static AppLifecycleException Denied(string message = "Private source access is unavailable. Reconnect in Shell Settings → Source connections, then review the app's source connections.")
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

    private Task<byte[]> ReadContentAsync(SourceReadGrant grant, SourceRepositoryFile file, long limit, CancellationToken ct)
        => UseGrantAsync(grant, async connection =>
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            using var request = connections.Providers.Resolve(connection.Provider).FileRequest(connection, file);
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
            ConfigureGit(start, grant.Repository, connections.Providers.Resolve(connection.Provider).GitAuthorization(connection).ToString());
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
        catch (UserConnectionException ex) { throw Denied(ex.Code == "provider_unsupported" ? ex.Message : "Private source access is unavailable. Check the selected connection in Shell settings."); }
    }

    private void ValidateProvider(UserProviderConnection connection, string repository)
    {
        var provider = connections.Providers.Resolve(connection.Provider);
        if (connections.Providers.ForUrl(repository).Descriptor.Id != provider.Descriptor.Id)
            throw Denied("The connection does not belong to this source provider.");
        _ = provider.NormalizeRepository(repository);
    }

    internal string NormalizeRepository(string value) => connections.Providers.ForUrl(value).NormalizeRepository(value);
    private SourceRepositoryFile ParseManifest(string value) => connections.Providers.ForUrl(value).ParseManifest(value);
}

internal static class RepositoryNames
{
    internal static string RemoveGitSuffix(this string value) => value.EndsWith(".git", StringComparison.OrdinalIgnoreCase) ? value[..^4] : value;
}
