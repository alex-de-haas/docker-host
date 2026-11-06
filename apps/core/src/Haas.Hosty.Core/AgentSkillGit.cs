namespace Haas.Hosty.Core;

internal sealed class AgentSkillCheckout(string path, string commit) : IDisposable
{
    public string Path { get; } = path;
    public string Commit { get; } = commit;
    public void Dispose() => AgentSkillCheckoutCleanup.Delete(Path);
}

internal interface IAgentSkillGit
{
    Task<AgentSkillCheckout> CheckoutAsync(AgentSkillGitRequest source, SourceReadGrant? grant, CancellationToken ct);
}

/// <summary>One isolated shallow checkout per source operation, never one clone per package.</summary>
internal sealed class AgentSkillGit(CoreDataPaths paths, ISourceGitAccess access) : IAgentSkillGit
{
    public static void Validate(AgentSkillGitRequest source)
    {
        if (source is null) throw AgentSkillPackages.Invalid("A Git source is required.");
        if (!Uri.TryCreate(source.Repository, UriKind.Absolute, out var uri) ||
            uri.Scheme is not ("https" or "http") || !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            throw AgentSkillPackages.Invalid("A skill source must be an HTTP(S) Git repository URL without credentials.");
        if (string.IsNullOrWhiteSpace(source.Ref) || source.Ref.Length > 256 || source.Ref.StartsWith('-') ||
            source.Ref.Any(char.IsControl) || source.Ref.Contains(':') || source.Ref.Contains(' ') ||
            source.Ref.Contains("..", StringComparison.Ordinal) || source.Ref.Contains("@{", StringComparison.Ordinal) ||
            source.Ref.IndexOfAny(['~', '^', '?', '*', '[', '\\']) >= 0)
            throw AgentSkillPackages.Invalid("Choose a Git branch, tag or commit.");
        AgentSkillPackages.RelativePath(source.Path, true);
    }

    public async Task<AgentSkillCheckout> CheckoutAsync(AgentSkillGitRequest source, SourceReadGrant? grant, CancellationToken ct)
    {
        Validate(source);
        var directory = System.IO.Path.Combine(paths.CoreRoot, "skills", "fetch", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            await RunAsync(directory, ["init", "--template="], ct);
            var fetch = new[] { "-c", "core.hooksPath=", "fetch", "--depth=1", "--no-tags", "--", source.Repository, source.Ref };
            if (grant is null) await RunAsync(directory, fetch, ct);
            else await access.GitAsync(grant, source.Repository, directory, fetch, ct);
            var commit = await RunAsync(directory, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], ct);
            await RunAsync(directory, ["-c", "core.hooksPath=", "checkout", "--detach", "--force", commit, "--"], ct);
            // Fetch metadata is not part of a portable package, including a package at repository root.
            AgentSkillCheckoutCleanup.Delete(System.IO.Path.Combine(directory, ".git"));
            return new(directory, commit);
        }
        catch { AgentSkillCheckoutCleanup.Delete(directory); throw; }
    }

    private static async Task<string> RunAsync(string directory, IReadOnlyList<string> arguments, CancellationToken ct)
    {
        var start = AppSourceService.CreateGitStartInfo(directory,
            ["-c", "credential.helper=", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", .. arguments]);
        // Public imports must not borrow credentials, hooks or filters from the host Git configuration.
        start.Environment["GIT_CONFIG_NOSYSTEM"] = "1";
        start.Environment["GIT_CONFIG_GLOBAL"] = OperatingSystem.IsWindows() ? "NUL" : "/dev/null";
        foreach (var key in start.Environment.Keys.Where(key => key.StartsWith("GIT_CONFIG_", StringComparison.Ordinal) &&
            key is not "GIT_CONFIG_NOSYSTEM" and not "GIT_CONFIG_GLOBAL").ToArray()) start.Environment.Remove(key);
        foreach (var key in new[] { "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES" })
            start.Environment.Remove(key);
        // libcurl can otherwise consult the operator's ~/.netrc even with credential helpers off.
        start.Environment["HOME"] = directory;
        start.Environment["USERPROFILE"] = directory;
        start.Environment["XDG_CONFIG_HOME"] = directory;
        var result = await ProcessRunner.RunAsync(start, TimeSpan.FromMinutes(2), ct);
        if (result.ExitCode != 0 || result.TimedOut)
            throw new AppLifecycleException("skill_source_unavailable", "Git skill source could not be read. Check its URL, ref and Source connection.");
        return result.StandardOutput.Trim();
    }
}
