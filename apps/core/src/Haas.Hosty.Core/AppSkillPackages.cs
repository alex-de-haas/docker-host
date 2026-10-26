using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

/// <summary>Prepare complete app packages before applying the app's new manifest.</summary>
internal sealed class AppSkillPackages(IAgentSkillGit git, SourceProviderRegistry providers, AgentSkillLibrary library)
{
    public async Task<Dictionary<string, AgentSkillPackage>> PrepareAsync(RuntimeAppManifestSelection selection, CancellationToken ct)
    {
        var declarations = selection.Manifest.Agent?.Skills ?? [];
        if (declarations.Length == 0) return [];
        AgentSkillCheckout? checkout = null;
        try
        {
            string manifestDirectory;
            if (selection.ManifestUrl is null)
                manifestDirectory = Path.GetDirectoryName(Path.GetFullPath(selection.ManifestPath))!;
            else
            {
                var file = providers.ForUrl(selection.ManifestUrl).ParseManifest(selection.ManifestUrl);
                var grant = selection.PrivateSources?.Git ?? selection.PrivateSources?.Manifest;
                checkout = await git.CheckoutAsync(new(file.Repository, file.Ref), grant, ct);
                if (!CoreDataPaths.TryResolveContainedRelativePath(checkout.Path, file.Path, out var manifestPath) ||
                    CoreDataPaths.ContainsSymbolicLink(checkout.Path, manifestPath))
                    throw AgentSkillPackages.Invalid("The app manifest path is outside its Git source.");
                var actual = await File.ReadAllTextAsync(manifestPath, ct);
                var digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(actual)));
                if (!digest.Equals(selection.ManifestDigest, StringComparison.OrdinalIgnoreCase))
                    throw new AppLifecycleException("skill_source_changed", "The app manifest changed while its skill packages were fetched. Review the update again.");
                manifestDirectory = Path.GetDirectoryName(manifestPath)!;
            }
            var packages = new Dictionary<string, AgentSkillPackage>(StringComparer.Ordinal);
            foreach (var declaration in declarations)
            {
                if (!CoreDataPaths.TryResolveContainedRelativePath(manifestDirectory, declaration.Path, out var directory) ||
                    CoreDataPaths.ContainsSymbolicLink(manifestDirectory, directory))
                    throw AgentSkillPackages.Invalid("An app skill must be a directory inside the manifest folder.");
                packages.Add(declaration.Key, await AgentSkillPackages.ReadAsync(directory, ct));
            }
            await library.ValidateAppAsync(selection.Manifest.Id!, packages, ct);
            return packages;
        }
        finally { checkout?.Dispose(); }
    }

    public async Task PublishAsync(RuntimeAppManifestSelection selection, string appRoot,
        Dictionary<string, AgentSkillPackage> packages, CancellationToken ct, Func<Task>? commitApp = null)
    {
        foreach (var declaration in selection.Manifest.Agent?.Skills ?? [])
        {
            var package = packages[declaration.Key];
            if (!CoreDataPaths.TryResolveContainedRelativePath(appRoot, declaration.Path, out var directory) ||
                CoreDataPaths.ContainsSymbolicLink(appRoot, directory))
                throw AgentSkillPackages.Invalid("The installed skill path must remain inside the app folder.");
            // The manifest owns these directories. Replacing the whole package removes stale files.
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
            foreach (var file in package.Files)
            {
                if (!CoreDataPaths.TryResolveContainedRelativePath(directory, file.Path, out var target))
                    throw AgentSkillPackages.Invalid("Invalid installed package path.");
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                await File.WriteAllBytesAsync(target, file.Content, ct);
                if (!OperatingSystem.IsWindows() && file.Executable)
                    File.SetUnixFileMode(target, File.GetUnixFileMode(target) | UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute);
            }
        }
        await library.ReplaceAppAsync(selection.Manifest.Id!, selection.Manifest.Version!, packages, ct, commitApp);
    }

    public async Task<T> CommitAsync<T>(RuntimeAppManifestSelection selection, string appRoot,
        Dictionary<string, AgentSkillPackage> packages, Func<Task<T>> commitApp, CancellationToken ct)
    {
        T result = default!;
        await PublishAsync(selection, appRoot, packages, ct, async () => { result = await commitApp(); });
        return result;
    }

    public Task RemoveAsync(string id, CancellationToken ct) => library.ReplaceAppAsync(id, "", new Dictionary<string, AgentSkillPackage>(), ct);
}
