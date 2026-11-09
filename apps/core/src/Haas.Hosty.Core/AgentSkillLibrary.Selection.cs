namespace Haas.Hosty.Core;

internal sealed partial class AgentSkillLibrary
{
    private static string[] ValidatePublicSelection(AgentSkillGitRequest source, string[] names)
    {
        AgentSkillGit.Validate(source);
        if (source.ConnectionId is not null)
            throw new AppLifecycleException("source_access_required", "Local skill imports support public repositories only. Use an administrator's Source connection through the skill management API for private repositories.");
        if (names is null || names.Length is 0 or > 200 || names.Any(n => !AgentSkillPackages.IsValidName(n)))
            throw AgentSkillPackages.Invalid("Select between one and 200 valid skill names.");
        return names.Distinct(StringComparer.Ordinal).ToArray();
    }

    private static async Task<AgentSkillMetadata[]> SelectAsync(string checkout, string relative, string[] names, CancellationToken ct)
    {
        var basePath = Resolve(checkout, relative);
        if (!Directory.Exists(basePath)) throw AgentSkillPackages.Invalid("The discovery directory does not exist.");
        var matches = names.ToDictionary(name => name, _ => new List<AgentSkillMetadata>(), StringComparer.Ordinal);
        var visited = 0;
        long metadataBytes = 0;
        async Task Visit(string directory, int depth)
        {
            ct.ThrowIfCancellationRequested();
            if (++visited > 10000 || depth > 20)
                throw AgentSkillPackages.Invalid("Source discovery exceeds the directory limit; narrow --path.");
            if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
                throw AgentSkillPackages.Invalid("Source discovery does not follow symbolic links.");
            if (File.Exists(Path.Combine(directory, "SKILL.md")))
            {
                var packagePath = Path.GetRelativePath(checkout, directory).Replace(Path.DirectorySeparatorChar, '/');
                packagePath = packagePath == "." ? "" : packagePath;
                AgentSkillPackages.RelativePath(packagePath, true);
                AgentSkillPackage metadata;
                try { metadata = await AgentSkillPackages.ReadMetadataAsync(directory, ct); }
                catch (AppLifecycleException ex)
                { throw AgentSkillPackages.Invalid($"Invalid metadata at '{packagePath}/SKILL.md': {ex.Message}"); }
                metadataBytes += metadata.Files[0].Content.LongLength;
                if (metadataBytes > MaxLibraryBytes)
                    throw AgentSkillPackages.Invalid("Source discovery exceeds 64 MiB of metadata; narrow --path.");
                if (matches.TryGetValue(metadata.Name, out var found))
                    found.Add(new(packagePath, metadata.Name, metadata.Description));
                return;
            }
            foreach (var child in Directory.EnumerateDirectories(directory).Order(StringComparer.Ordinal))
                if (Path.GetFileName(child) != ".git") await Visit(child, depth + 1);
        }
        await Visit(basePath, 0);
        var missing = matches.Where(pair => pair.Value.Count == 0).Select(pair => pair.Key).ToArray();
        if (missing.Length > 0)
            throw new AppLifecycleException("skill_not_found", $"No matching skill names in the selected source: {string.Join(", ", missing)}. Check --skill and --path.");
        foreach (var (name, found) in matches)
            if (found.Count > 1)
                throw new AppLifecycleException("skill_name_ambiguous", $"Skill '{name}' matches multiple packages: {string.Join(", ", found.Take(10).Select(s => s.Path.Length == 0 ? "." : s.Path))}. Narrow --path.");
        return names.Select(name => matches[name][0]).ToArray();
    }

    public async Task<AgentSkillSelection> DiscoverSelectedAsync(AgentSkillSelectionRequest request, CancellationToken ct)
    {
        var names = ValidatePublicSelection(request.Source, request.Names);
        using var checkout = await git.CheckoutAsync(request.Source, null, ct);
        var selected = await SelectAsync(checkout.Path, request.Source.Path, names, ct);
        return new(request.Source.Repository, request.Source.Ref, checkout.Commit, selected);
    }

    public async Task<AgentSkillCatalog> InstallSelectedAsync(AgentSkillSelectedInstallRequest request, CancellationToken ct)
    {
        var names = ValidatePublicSelection(request.Source, request.Names);
        if (string.IsNullOrWhiteSpace(request.Commit)) throw AgentSkillPackages.Invalid("A discovery commit is required.");
        using var checkout = await git.CheckoutAsync(request.Source, null, ct);
        if (checkout.Commit != request.Commit)
            throw new AppLifecycleException("skill_source_changed", "The source changed; run skills add again to discover its current packages.");
        var selected = await SelectAsync(checkout.Path, request.Source.Path, names, ct);
        var entries = new List<AgentSkillEntry>();
        foreach (var candidate in selected)
        {
            var directory = Resolve(checkout.Path, candidate.Path);
            var package = await AgentSkillPackages.ReadAsync(directory, ct, candidate.Path.Length != 0);
            entries.Add(Entry(Id("git", request.Source.Repository, request.Source.Ref, candidate.Path), package,
                "git", null, null, request.Source.Repository, request.Source.Ref, candidate.Path, checkout.Commit, null));
        }
        await PublishGitAsync(entries.ToArray(), ct);
        return new(entries.Select(entry => entry.Info).ToArray());
    }
}
