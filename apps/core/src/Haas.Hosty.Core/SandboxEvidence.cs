using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

// Verification binds to the actual tracked and untracked worktree bytes, including deletions.
// Git-ignored dependency/build caches are execution state, not application source. Symlinks are
// hashed as links and never followed into an unrelated directory.
internal static class SandboxEvidence
{
    internal static async Task<string> SourceRevisionAsync(SandboxInstance instance, CancellationToken ct)
    {
        if (instance.Input.SourceRoot is not { } root) return instance.Input.Digest;
        var command = DevelopmentWorkspaceService.GitStartInfo(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
        var files = await ProcessRunner.RunAsync(command, TimeSpan.FromSeconds(30), ct, 4 * 1024 * 1024);
        if (files.ExitCode != 0 || files.TimedOut || files.StandardOutput.Length >= 4 * 1024 * 1024) throw new SandboxException("sandbox_source_unknown", "The verification source inventory could not be observed.");
        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        void Add(string value) => digest.AppendData(Encoding.UTF8.GetBytes(value + "\0"));
        Add(instance.Input.Digest);
        long total = 0;
        foreach (var relative in files.StandardOutput.Split('\0', StringSplitOptions.RemoveEmptyEntries).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            ct.ThrowIfCancellationRequested();
            if (!CoreDataPaths.TryResolveContainedRelativePath(root, relative, out var path))
                throw new SandboxException("sandbox_source_invalid", "The source inventory contains an invalid path.");
            Add(relative);
            var info = new FileInfo(path);
            if (info.LinkTarget is { } target) { Add("link:" + target); continue; }
            if (CoreDataPaths.ContainsSymbolicLink(root, path))
                throw new SandboxException("sandbox_source_invalid", "The source inventory crosses a symbolic link.");
            if (!info.Exists) { Add("missing"); continue; }
            total = checked(total + info.Length);
            if (total > 8589934592) throw new SandboxException("sandbox_source_quota", "The source inventory exceeds the 8 GiB review budget.");
            Add(info.Length.ToString(System.Globalization.CultureInfo.InvariantCulture));
            await using var stream = File.OpenRead(path);
            var hash = await SHA256.HashDataAsync(stream, ct);
            digest.AppendData(hash);
        }
        return Convert.ToHexString(digest.GetHashAndReset()).ToLowerInvariant();
    }
}
