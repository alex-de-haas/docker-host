using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

internal sealed record CoreSourceSelection(string RepositoryUrl, string? Ref = null,
    string ProjectPath = CoreSourceDefaults.ProjectPath, string? ConnectionId = null);

internal sealed partial class CoreDevelopmentService
{
    internal string NormalizeRepository(string value)
    {
        if (value is null || value.Length > 2048 || value.Any(char.IsControl)
            || CoreBuildProvenance.SafeRepository(value.Trim()) is not { } repository)
            throw new ArgumentException("Use a complete HTTP/HTTPS repository URL without credentials, query or fragment.");
        AppSourceService.ValidateManagedRepository(repository);
        if (privateSources is not null)
        {
            try { return privateSources.NormalizeRepository(repository); }
            catch (AppLifecycleException) { }
        }
        if (new Uri(repository).Host == "github.com")
        {
            try { return "https://github.com/" + GitHubPublicationProvider.Repository(repository).ToLowerInvariant() + ".git"; }
            catch (PublicationException) { throw new ArgumentException("Use a complete GitHub HTTPS repository URL."); }
        }
        return repository;
    }

    internal async Task<CoreSourceSettings> SourceSettingsAsync(CancellationToken ct)
    {
        var saved = CoreLaunchFiles.Read(CoreLaunchFiles.SourcePath(config.DataRoot), CoreLaunchJson.Default.CoreSourceSettings);
        if (saved?.SchemaVersion >= 1) return saved;
        var legacyRoot = saved?.OverridePath ?? LegacyManagedPath;
        string? repository = null;
        if (Directory.Exists(legacyRoot))
        {
            try
            {
                var result = await DevelopmentWorkspaceService.Git(legacyRoot, ["config", "--get", "remote.origin.url"], ct, true);
                repository = NormalizeRepository(result.StandardOutput.Trim());
            }
            catch (Exception ex) when (ex is ArgumentException or AppLifecycleException or IOException)
            { /* An unavailable legacy checkout has unknown provenance, not an official-repository guess. */ }
        }
        else if (saved is { OverridePath: null })
            repository = CoreSourceDefaults.UpdateRepository + ".git"; // The legacy standard source contract.
        else if (saved is null && CoreBuildProvenance.Current.Repository is { } builtFrom)
        {
            try { repository = NormalizeRepository(builtFrom); }
            catch (ArgumentException) { /* Unsupported build identity needs explicit source configuration. */ }
        }
        return (saved ?? new(null, "initial", LegacyCheckout: Directory.Exists(legacyRoot))) with
        { RepositoryUrl = repository, SchemaVersion = 1 };
    }

    private string ManagedRoot(CoreSourceSettings settings) => settings.LegacyCheckout ? LegacyManagedPath
        : Path.Combine(config.DataRoot, "core", "sources",
            DevelopmentWorkspaceService.Hash((settings.RepositoryUrl ?? "unconfigured") + "\n" + settings.Ref));
    internal string SelectedRoot(CoreSourceSettings settings) => settings.OverridePath ?? ManagedRoot(settings);

    internal static string Project(string root, string relative = CoreSourceDefaults.ProjectPath)
    {
        if (string.IsNullOrWhiteSpace(relative) || relative.Length > 1024 || relative.Any(char.IsControl)
            || Path.IsPathRooted(relative) || relative.Contains('\\') || relative.Contains(':') || relative.Split('/').Any(p => p is "" or "." or "..")
            || !relative.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Core project must be a contained repository-relative .csproj path.");
        var result = Path.GetFullPath(Path.Combine(root, relative));
        if (!DevelopmentWorkspaceService.IsUnder(root, result))
            throw new ArgumentException("The Core project escapes its repository.");
        return result;
    }

    internal async Task<SourceReadGrant?> SourceGrantAsync(CoreSourceSettings source, string? actor, CancellationToken ct, UserProviderConnection? heldConnection = null, bool localOnly = false)
    {
        if (source.ConnectionId is null) return null;
        if (source.ConnectionOwnerId is null || source.RepositoryUrl is null || actor != source.ConnectionOwnerId)
            throw PrivateSourceService.Denied("The configured Core source belongs to another user.");
        var access = privateSources ?? throw PrivateSourceService.Denied();
        var grant = heldConnection is null
            ? localOnly ? await access.BindLocalAsync(actor, source.ConnectionId, source.RepositoryUrl, ct)
                : await access.BindAsync(actor, source.ConnectionId, source.RepositoryUrl, false, ct)
            : new SourceReadGrant(actor, source.ConnectionId, heldConnection.Provider, heldConnection.AccountName,
                heldConnection.Label, access.NormalizeRepository(source.RepositoryUrl));
        if (heldConnection is null && localOnly) await access.ValidateLocalAsync(new(Git: grant), ct);
        else if (heldConnection is null) await access.ValidateAsync(new(Git: grant), ct);
        else access.ValidateWithConnection(new(Git: grant), heldConnection);
        return grant;
    }

    public async Task<CoreSourceSettings> SaveAsync(CoreSourceRequest request, CancellationToken cancellationToken,
        string? actor = null)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            using var lease = CoreLaunchFiles.Lock(config.DataRoot);
            CheckBusy();
            var old = await SourceSettingsAsync(cancellationToken);
            if (request.Revision != old.Revision) throw new InvalidOperationException("Source changed; refresh before saving.");
            var next = old;
            if (request.Repository is { } selection)
            {
                var repository = NormalizeRepository(selection.RepositoryUrl);
                var reference = string.IsNullOrWhiteSpace(selection.Ref) ? null : selection.Ref.Trim();
                if (reference is not null)
                {
                    if (reference.Length > 256 || reference.StartsWith('-') || reference.Any(char.IsControl))
                        throw new ArgumentException("Use a branch or tag ref.");
                    var valid = await DevelopmentWorkspaceService.Git(config.DataRoot, ["check-ref-format", "refs/heads/" + reference], cancellationToken, true);
                    if (valid.ExitCode != 0) throw new ArgumentException("Use a valid branch or tag ref.");
                }
                _ = Project(config.DataRoot, selection.ProjectPath);
                next = old with { RepositoryUrl = repository, Ref = reference, ProjectPath = selection.ProjectPath,
                    LegacyCheckout = old.LegacyCheckout && old.RepositoryUrl == repository && old.Ref == reference,
                    ConnectionId = string.IsNullOrWhiteSpace(selection.ConnectionId) ? null : selection.ConnectionId,
                    ConnectionOwnerId = string.IsNullOrWhiteSpace(selection.ConnectionId) ? null : actor };
                if (next.ConnectionId is not null) _ = await SourceGrantAsync(next, actor, cancellationToken);
            }
            else if (old.ConnectionId is not null) _ = await SourceGrantAsync(old, actor, cancellationToken);
            string? path = null;
            if (!string.IsNullOrWhiteSpace(request.OverridePath))
            {
                if (!Path.IsPathFullyQualified(request.OverridePath)) throw new InvalidOperationException("Source override must be an absolute host path.");
                path = Path.TrimEndingDirectorySeparator(Path.GetFullPath(request.OverridePath));
                if (!File.Exists(Project(path, next.ProjectPath))) throw new InvalidOperationException("The selected folder does not contain the Core project.");
            }
            next = next with { OverridePath = path };
            var pending = launch.Mode == "dev" && !string.Equals(Project(SelectedRoot(next), next.ProjectPath),
                launch.ProjectPath is { } project ? Path.GetFullPath(project) : null,
                OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
            next = next with { PendingForInstance = pending ? Instance : null };
            // An explicit save also pins a projected legacy/build default. Otherwise a later build
            // or checkout change could silently change an apparently saved source selection.
            var persisted = CoreLaunchFiles.Read(CoreLaunchFiles.SourcePath(config.DataRoot), CoreLaunchJson.Default.CoreSourceSettings);
            if (old == next && persisted?.SchemaVersion >= 1) return old;
            next = next with { Revision = Guid.NewGuid().ToString("N") };
            CoreLaunchFiles.Write(CoreLaunchFiles.SourcePath(config.DataRoot), next, CoreLaunchJson.Default.CoreSourceSettings);
            return next;
        }
        finally { gate.Release(); }
    }

    internal async Task<string> PrepareSourceAsync(CoreSourceSettings source, CancellationToken ct,
        string? repository = null, string? actor = null)
    {
        // The optional transport is an internal local-Git test seam, never an HTTP argument.
        var root = SelectedRoot(source);
        var grant = await SourceGrantAsync(source, actor, ct);
        if (source.OverridePath is null && !Directory.Exists(root))
        {
            var remote = repository ?? source.RepositoryUrl
                ?? throw new InvalidOperationException("Configure the Core repository URL before preparing development source.");
            var temp = root + "." + Guid.NewGuid().ToString("N");
            Directory.CreateDirectory(Path.GetDirectoryName(root)!);
            try
            {
                var args = new List<string> { "clone" };
                if (source.Ref is { } reference) args.AddRange(["--branch", reference]);
                args.AddRange(["--", remote, temp]);
                if (grant is null)
                    await DevelopmentWorkspaceService.Git(Path.GetDirectoryName(root)!, ["-c", "http.followRedirects=false", .. args], ct);
                else await (privateSources ?? throw PrivateSourceService.Denied()).GitAsync(grant, remote, Path.GetDirectoryName(root)!, args, ct);
                if (!File.Exists(Project(temp, source.ProjectPath)))
                    throw new InvalidOperationException("The selected repository/ref does not contain the Core project.");
                Directory.Move(temp, root);
            }
            finally { if (Directory.Exists(temp)) Directory.Delete(temp, true); }
        }
        if (source.OverridePath is null && !source.LegacyCheckout && repository is null && source.RepositoryUrl is not null)
        {
            var origin = await DevelopmentWorkspaceService.Git(root, ["config", "--get", "remote.origin.url"], ct, true);
            if (NormalizeRepository(origin.StandardOutput.Trim()) != source.RepositoryUrl)
                throw new InvalidOperationException("Managed Core checkout has a different origin; retained source is unchanged.");
        }
        var project = Project(root, source.ProjectPath);
        if (!File.Exists(project)) throw new InvalidOperationException("Core source project is unavailable.");
        return project;
    }
}
