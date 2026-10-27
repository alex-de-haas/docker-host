using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

/// <summary>One current-content library with serialized publication and independent native exports.</summary>
internal sealed class AgentSkillLibrary(CoreDataPaths paths, IAgentSkillGit git, ISourceGitAccess access, IClock clock, ILogger<AgentSkillLibrary>? logger = null)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private string Root => Path.Combine(paths.CoreRoot, "skills");
    private string StatePath => Path.Combine(Root, "library.json");
    private const long MaxLibraryBytes = 64 * 1024 * 1024;

    internal static string Id(params string[] parts) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n', parts))));

    private Task<AgentSkillLibraryState?> ReadAsync(CancellationToken ct) =>
        JsonStorage.ReadAsync<AgentSkillLibraryState>(StatePath, ct);

    public async Task<AgentSkillCatalog> CatalogAsync(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try { return new((await ReadAsync(ct) ?? AgentSkillLibraryState.Empty).Skills.Select(s => s.Info).OrderBy(s => s.Name).ToArray()); }
        finally { gate.Release(); }
    }

    public async Task<AgentSkillContent> ContentAsync(string id, string relative, CancellationToken ct)
    {
        AgentSkillPackages.RelativePath(relative);
        await gate.WaitAsync(ct);
        try
        {
            var entry = (await ReadAsync(ct))?.Skills.FirstOrDefault(s => s.Info.Id == id);
            var file = entry?.Files.FirstOrDefault(f => f.Path == relative);
            if (entry is null || file is null) throw new AppLifecycleException("skill_not_found", "The skill or file is no longer installed.");
            return new(entry.Info, relative, file.Content, entry.Files.Select(f => f.Path).ToArray());
        }
        finally { gate.Release(); }
    }

    private async Task<SourceReadGrant?> BindAsync(string owner, AgentSkillGitRequest source, CancellationToken ct)
    {
        AgentSkillGit.Validate(source);
        return source.ConnectionId is null ? null : await access.BindAsync(owner, source.ConnectionId, source.Repository, false, ct);
    }

    private static string Resolve(string root, string relative)
    {
        if (relative.Length == 0) return root;
        if (!CoreDataPaths.TryResolveContainedRelativePath(root, AgentSkillPackages.RelativePath(relative), out var resolved) ||
            CoreDataPaths.ContainsSymbolicLink(root, resolved))
            throw AgentSkillPackages.Invalid("Skill path is outside its source or passes through a symbolic link.");
        return resolved;
    }

    private static async Task<(string Path, AgentSkillPackage Package)[]> DiscoverAsync(
        string checkout, string relative, CancellationToken ct)
    {
        var basePath = Resolve(checkout, relative);
        if (!Directory.Exists(basePath)) throw AgentSkillPackages.Invalid("The discovery directory does not exist.");
        var found = new List<(string, AgentSkillPackage)>();
        var visited = 0;
        async Task Visit(string directory, int depth)
        {
            if (++visited > 10000 || depth > 20) throw AgentSkillPackages.Invalid("Source discovery exceeds the directory limit; choose a subdirectory.");
            ct.ThrowIfCancellationRequested();
            if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
                throw AgentSkillPackages.Invalid("Source discovery does not follow symbolic links.");
            if (File.Exists(Path.Combine(directory, "SKILL.md")))
            {
                if (found.Count >= 200) throw AgentSkillPackages.Invalid("Choose a subdirectory containing at most 200 skills.");
                var packagePath = Path.GetRelativePath(checkout, directory).Replace(Path.DirectorySeparatorChar, '/');
                found.Add((packagePath == "." ? "" : packagePath, await AgentSkillPackages.ReadAsync(directory, ct, directory != checkout)));
                return;
            }
            foreach (var child in Directory.EnumerateDirectories(directory).Order(StringComparer.Ordinal))
                if (Path.GetFileName(child) != ".git") await Visit(child, depth + 1);
        }
        await Visit(basePath, 0);
        return found.ToArray();
    }

    public async Task<AgentSkillDiscovery> DiscoverAsync(string owner, AgentSkillGitRequest source, CancellationToken ct)
    {
        var grant = await BindAsync(owner, source, ct);
        using var checkout = await git.CheckoutAsync(source, grant, ct);
        var candidates = await DiscoverAsync(checkout.Path, source.Path, ct);
        return new(source.Repository, source.Ref, checkout.Commit,
            candidates.Select(c => new AgentSkillCandidate(c.Path, c.Package.Name, c.Package.Description,
                c.Package.Files.Length, c.Package.Files.Sum(f => f.Content.LongLength))).ToArray());
    }

    public async Task<AgentSkillCatalog> InstallAsync(string owner, AgentSkillInstallRequest request, CancellationToken ct)
    {
        if (request.Paths is null || request.Paths.Any(p => p is null) || request.Paths.Length is 0 or > 200 || request.Paths.Distinct(StringComparer.Ordinal).Count() != request.Paths.Length)
            throw AgentSkillPackages.Invalid("Select between one and 200 distinct packages.");
        var grant = await BindAsync(owner, request.Source, ct);
        using var checkout = await git.CheckoutAsync(request.Source, grant, ct);
        if (checkout.Commit != request.Commit) throw new AppLifecycleException("skill_source_changed", "The source changed; discover its packages again.");
        var discovered = await DiscoverAsync(checkout.Path, request.Source.Path, ct);
        var entries = request.Paths.Select(p =>
        {
            var candidate = discovered.FirstOrDefault(c => c.Path == p);
            if (candidate.Package is null) throw AgentSkillPackages.Invalid("Select packages returned by source discovery.");
            var package = candidate.Package;
            return Entry(Id("git", request.Source.Repository, request.Source.Ref, p), package,
                "git", null, null, request.Source.Repository, request.Source.Ref, p, checkout.Commit, grant);
        }).ToArray();
        await gate.WaitAsync(ct);
        try
        {
            var state = await ReadAsync(ct) ?? AgentSkillLibraryState.Empty;
            // Reinstallation of the same origin is explicit; unrelated packages can never be overwritten.
            await PublishAsync(state with { Skills = state.Skills.Where(s => !entries.Any(e => e.Info.Id == s.Info.Id)).Concat(entries).ToArray() }, ct);
        }
        finally { gate.Release(); }
        return await CatalogAsync(ct);
    }

    private AgentSkillEntry Entry(string id, AgentSkillPackage package, string kind, string? appId,
        string? version, string? repository, string? reference, string path, string? commit, SourceReadGrant? grant) =>
        new(new(id, package.Name, package.Description, kind, appId, version, repository, reference, path, commit,
            package.Files.Length, package.Files.Sum(f => f.Content.LongLength), clock.UtcNow), package.Files, grant);

    public async Task<AgentSkillUpdates> UpdateAsync(string owner, AgentSkillUpdateRequest request, bool apply, CancellationToken ct)
    {
        if (request.SkillIds is null || request.SkillIds.Length > 200 || request.SkillIds.Any(string.IsNullOrWhiteSpace))
            throw AgentSkillPackages.Invalid("Select at most 200 skill IDs.");
        AgentSkillLibraryState baseline;
        await gate.WaitAsync(ct);
        try { baseline = await ReadAsync(ct) ?? AgentSkillLibraryState.Empty; }
        finally { gate.Release(); }
        var selected = baseline.Skills.Where(s => request.SkillIds.Contains(s.Info.Id, StringComparer.Ordinal)).ToArray();
        if (selected.Any(s => s.Info.SourceKind != "git"))
            throw AgentSkillPackages.Invalid("App skills update with their supplying app.");
        var updates = new List<AgentSkillUpdate>();
        var replacements = new Dictionary<string, AgentSkillEntry?>(StringComparer.Ordinal);
        foreach (var group in selected.GroupBy(s => (s.Info.Repository, s.Info.Ref, s.SourceGrant)))
        {
            try
            {
                if (group.Key.SourceGrant is { } grant && grant.OwnerId != owner)
                    throw PrivateSourceService.Denied("The administrator who selected this Source connection must update these skills.");
                var source = new AgentSkillGitRequest(group.Key.Repository!, group.Key.Ref!);
                using var checkout = await git.CheckoutAsync(source, group.Key.SourceGrant, ct);
                foreach (var entry in group)
                {
                    var directory = Resolve(checkout.Path, entry.Info.Path);
                    var removed = !File.Exists(Path.Combine(directory, "SKILL.md"));
                    updates.Add(new(entry.Info.Id, entry.Info.Commit, checkout.Commit, removed));
                    if (removed) replacements[entry.Info.Id] = null;
                    else
                    {
                        var package = await AgentSkillPackages.ReadAsync(directory, ct, entry.Info.Path.Length != 0);
                        replacements[entry.Info.Id] = entry with
                        {
                            Info = entry.Info with { Name = package.Name, Description = package.Description, Commit = checkout.Commit,
                                FileCount = package.Files.Length, Bytes = package.Files.Sum(f => f.Content.LongLength), InstalledAt = clock.UtcNow },
                            Files = package.Files
                        };
                    }
                }
            }
            catch (AppLifecycleException ex) when (!apply)
            {
                foreach (var entry in group)
                {
                    replacements.Remove(entry.Info.Id);
                    updates.RemoveAll(u => u.Id == entry.Info.Id);
                    updates.Add(new(entry.Info.Id, entry.Info.Commit, null, false, ex.Message));
                }
            }
        }
        if (apply)
        {
            await gate.WaitAsync(ct);
            try
            {
                var current = await ReadAsync(ct) ?? AgentSkillLibraryState.Empty;
                if (selected.Any(s => current.Skills.FirstOrDefault(c => c.Info.Id == s.Info.Id)?.Info != s.Info))
                    throw new AppLifecycleException("skill_library_changed", "Selected skills changed during the update. Check again.");
                await PublishAsync(current with { Skills = current.Skills.Select(s => replacements.TryGetValue(s.Info.Id, out var replacement) ? replacement : s).OfType<AgentSkillEntry>().ToArray() }, ct);
            }
            finally { gate.Release(); }
        }
        return new(updates.ToArray());
    }

    public async Task RemoveAsync(string id, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var state = await ReadAsync(ct) ?? AgentSkillLibraryState.Empty;
            if (state.Skills.Any(s => s.Info.Id == id && s.Info.SourceKind == "app"))
                throw AgentSkillPackages.Invalid("Remove app skills by updating or removing their supplying app.");
            await PublishAsync(state with { Skills = state.Skills.Where(s => s.Info.Id != id).ToArray() }, ct);
        }
        finally { gate.Release(); }
    }

    public async Task ValidateAppAsync(string appId, IReadOnlyDictionary<string, AgentSkillPackage> packages, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var state = await ReadAsync(ct) ?? AgentSkillLibraryState.Empty;
            var names = state.Skills.Where(s => s.Info.AppId != appId).Select(s => s.Info.Name).Concat(packages.Values.Select(p => p.Name)).ToArray();
            if (names.Distinct(StringComparer.OrdinalIgnoreCase).Count() != names.Length)
                throw new AppLifecycleException("skill_name_conflict", "A different package already uses an app skill's native name.");
            if (names.Length > 200 || state.Skills.Where(s => s.Info.AppId != appId).Sum(s => s.Info.Bytes) + packages.Values.Sum(p => p.Files.Sum(f => f.Content.LongLength)) > MaxLibraryBytes)
                throw AgentSkillPackages.Invalid("The shared library is limited to 200 skills and 64 MiB.");
        }
        finally { gate.Release(); }
    }

    public async Task ReplaceAppAsync(string appId, string version,
        IReadOnlyDictionary<string, AgentSkillPackage> packages, CancellationToken ct, Func<Task>? commitApp = null)
    {
        var entries = packages.Select(p => Entry(Id("app", appId, p.Key), p.Value, "app", appId, version,
            null, null, p.Key, null, null)).ToArray();
        await gate.WaitAsync(ct);
        try
        {
            var state = await ReadAsync(ct) ?? AgentSkillLibraryState.Empty;
            var next = state with { Skills = state.Skills.Where(s => s.Info.AppId != appId).Concat(entries).ToArray() };
            // Prepare every export and the state file before committing the app record. Invalid
            // packages, full disks and cancellation during preparation preserve the current library.
            await PublishAsync(next, ct, commitApp);
        }
        finally { gate.Release(); }
    }

    public async Task<AgentSkillExportResult> ExportAsync(string owner, AgentSkillExportRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.ContextId) || request.ContextId.Length > 256 || request.SkillIds is null || request.SkillIds.Length > 200 || request.SkillIds.Any(string.IsNullOrWhiteSpace))
            throw AgentSkillPackages.Invalid("An export requires a context ID and at most 200 skills.");
        var id = Id(owner, request.ContextId);
        await gate.WaitAsync(ct);
        try
        {
            var state = await ReadAsync(ct) ?? AgentSkillLibraryState.Empty;
            var export = new AgentSkillExport(id, owner, request.SkillIds.Distinct(StringComparer.Ordinal).ToArray());
            state = state with { Exports = state.Exports.Where(e => e.Id != id).Append(export).ToArray() };
            if (state.Exports.Length > 1000) throw AgentSkillPackages.Invalid("Release unused skill exports before creating more.");
            await PublishAsync(state, ct, exports: [export]);
            return new(id, ExportPath(export), Selected(state, export).Select(s => s.Info).ToArray());
        }
        finally { gate.Release(); }
    }

    public async Task ReleaseExportAsync(string owner, string id, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var state = await ReadAsync(ct) ?? AgentSkillLibraryState.Empty;
            var export = state.Exports.FirstOrDefault(e => e.Id == id && e.Owner == owner);
            if (export is null) return;
            await JsonStorage.WriteAsync(StatePath, state with { Exports = state.Exports.Where(e => e.Id != id).ToArray() }, restrictToOwner: true, ct);
            if (Directory.Exists(ExportPath(export))) Directory.Delete(ExportPath(export), true);
        }
        finally { gate.Release(); }
    }

    private string ExportPath(AgentSkillExport export) => Path.Combine(Root, "exports", Id(export.Owner), export.Id);
    private static AgentSkillEntry[] Selected(AgentSkillLibraryState state, AgentSkillExport export) =>
        state.Skills.Where(s => export.SkillIds.Contains(s.Info.Id, StringComparer.Ordinal)).ToArray();

    public async Task RecoverExportsAsync(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var state = await ReadAsync(ct) ?? AgentSkillLibraryState.Empty;
            foreach (var export in state.Exports) await MaterializeAsync(state, export, ct);
            var staging = Path.Combine(Root, "staging");
            if (Directory.Exists(staging)) Directory.Delete(staging, true);
            var fetch = Path.Combine(Root, "fetch");
            try { AgentSkillCheckoutCleanup.Delete(fetch); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Fetch leftovers are disposable; an external lock must not prevent Core startup.
                logger?.LogWarning(ex, "Could not remove temporary skill checkouts at {Path}; retained for the next recovery.", fetch);
            }
        }
        finally { gate.Release(); }
    }

    private static void ValidateState(AgentSkillLibraryState state)
    {
        if (state.Skills.Length > 200 || state.Skills.Sum(s => s.Info.Bytes) > MaxLibraryBytes)
            throw AgentSkillPackages.Invalid("The shared library is limited to 200 skills and 64 MiB.");
        if (state.Skills.GroupBy(s => s.Info.Name, StringComparer.OrdinalIgnoreCase).Any(g => g.Count() > 1))
            throw new AppLifecycleException("skill_name_conflict", "A different package already uses this native skill name. Remove it before installing a replacement.");
    }

    private async Task PublishAsync(AgentSkillLibraryState state, CancellationToken ct,
        Func<Task>? commitApp = null, AgentSkillExport[]? exports = null)
    {
        ValidateState(state);
        var prepared = new List<(AgentSkillExport Export, string Stage)>();
        var stateStage = Path.Combine(Root, "staging", Guid.NewGuid().ToString("N") + ".json");
        try
        {
            foreach (var export in exports ?? state.Exports)
                prepared.Add((export, await PrepareExportAsync(state, export, ct)));
            await JsonStorage.WriteAsync(stateStage, state, restrictToOwner: true, ct);
            ct.ThrowIfCancellationRequested();
            if (commitApp is not null) await commitApp();
            // Once committed, finish publication even if the requesting client disconnects. The
            // current-state document is the recovery authority after a process or rename failure.
            File.Move(stateStage, StatePath, overwrite: true);
            foreach (var item in prepared) PublishExport(state, item.Export, item.Stage);
        }
        finally
        {
            if (File.Exists(stateStage)) File.Delete(stateStage);
            foreach (var item in prepared)
                if (Directory.Exists(item.Stage)) Directory.Delete(item.Stage, true);
        }
    }

    private async Task MaterializeAsync(AgentSkillLibraryState state, AgentSkillExport export, CancellationToken ct)
    {
        var stage = await PrepareExportAsync(state, export, ct);
        try { PublishExport(state, export, stage); }
        finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
    }

    private async Task<string> PrepareExportAsync(AgentSkillLibraryState state, AgentSkillExport export, CancellationToken ct)
    {
        var stage = Path.Combine(Root, "staging", Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(stage);
            foreach (var entry in Selected(state, export))
                foreach (var file in entry.Files)
                {
                    var destination = Resolve(stage, entry.Info.Name + "/" + file.Path);
                    Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                    await File.WriteAllBytesAsync(destination, file.Content, ct);
                    if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(destination,
                        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead |
                        (file.Executable ? UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute : 0));
                }
            return stage;
        }
        catch
        {
            if (Directory.Exists(stage)) Directory.Delete(stage, true);
            throw;
        }
    }

    private void PublishExport(AgentSkillLibraryState state, AgentSkillExport export, string stage)
    {
        var directory = ExportPath(export);
        Directory.CreateDirectory(directory);
        var entries = Selected(state, export);
        // The parent inode remains stable for Docker binds. Each package is prepared in full;
        // consumers may briefly see a missing directory during the two-rename replacement.
        foreach (var entry in entries)
        {
            var target = Path.Combine(directory, entry.Info.Name);
            var prepared = Path.Combine(stage, entry.Info.Name);
            var retired = prepared + ".replaced";
            if (Directory.Exists(target)) Directory.Move(target, retired);
            try { Directory.Move(prepared, target); }
            catch
            {
                if (Directory.Exists(retired)) Directory.Move(retired, target);
                throw;
            }
            if (Directory.Exists(retired)) Directory.Delete(retired, true);
        }
        foreach (var old in Directory.EnumerateDirectories(directory))
            if (!entries.Any(e => e.Info.Name == Path.GetFileName(old))) Directory.Delete(old, true);
    }

}

internal sealed class AgentSkillRecovery(AgentSkillLibrary library) : IHostedService
{
    public Task StartAsync(CancellationToken ct) => library.RecoverExportsAsync(ct);
    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
