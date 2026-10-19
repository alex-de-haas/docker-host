using System.IO.Compression;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class CoreStateSnapshotTests : IDisposable
{
    private readonly string root = Directory.CreateTempSubdirectory("hosty-core-snapshot-").FullName;
    private void FileAt(string path, string content = "retained")
    {
        var full = Path.Combine(root, path); Directory.CreateDirectory(Path.GetDirectoryName(full)!); File.WriteAllText(full, content);
    }
    [Fact]
    public void SnapshotRequiresStoppedCoreAndContainsStateWithoutAppDataOrSources()
    {
        FileAt("core/auth/users.json"); FileAt("core/settings.json"); FileAt("core/development/workspaces/workspace.json");
        FileAt("core/development/trees/task/edit.txt"); FileAt("core/development/repositories/repo.git/HEAD");
        FileAt("apps/test.app/state.json"); FileAt("apps/test.app/secrets.json"); FileAt("apps/test.app/data/user.txt"); FileAt("apps/test.app/source/edit.txt");
        FileAt("core/run/core.lock");
        var id = Guid.NewGuid().ToString();
        using (new FileStream(Path.Combine(root, "core/run/core.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            Assert.Throws<IOException>(() => CoreStateSnapshot.Create(root, id));
        var snapshot = CoreStateSnapshot.Create(root, id);
        using var zip = ZipFile.OpenRead(snapshot.Archive);
        Assert.Equal(new[] { "apps/test.app/secrets.json", "apps/test.app/state.json", "core/auth/users.json", "core/development/workspaces/workspace.json", "core/settings.json" },
            zip.Entries.Select(e => e.FullName).Order(StringComparer.Ordinal).ToArray());
        Assert.Equal(snapshot, CoreStateSnapshot.Create(root, id));
        Assert.Equal("retained", File.ReadAllText(Path.Combine(root, "apps/test.app/data/user.txt")));
        Assert.Equal("retained", File.ReadAllText(Path.Combine(root, "core/development/trees/task/edit.txt")));
    }
    [Fact]
    public void SnapshotRefusesLinkedStateAndTamperedArchive()
    {
        FileAt("core/run/core.lock"); FileAt("core/settings.json"); FileAt("outside/secret");
        var link = Path.Combine(root, "core/linked");
        File.CreateSymbolicLink(link, Path.Combine(root, "outside/secret"));
        Assert.Throws<IOException>(() => CoreStateSnapshot.Preflight(root));
        File.Delete(link);
        var id = Guid.NewGuid().ToString(); var snapshot = CoreStateSnapshot.Create(root, id);
        File.AppendAllText(snapshot.Archive, "corrupt");
        Assert.Throws<IOException>(() => CoreStateSnapshot.Create(root, id));
        Assert.Equal("retained", File.ReadAllText(Path.Combine(root, "core/settings.json")));
    }
    [Fact]
    public void SnapshotRefusesLinkedDestinationAndUnreceiptedArchiveWithoutOverwriting()
    {
        FileAt("core/run/core.lock"); FileAt("core/settings.json"); FileAt("outside/sentinel");
        var destination = Path.Combine(root, "core/workspace-snapshots");
        Directory.CreateSymbolicLink(destination, Path.Combine(root, "outside"));
        Assert.Throws<IOException>(() => CoreStateSnapshot.Preflight(root));
        Assert.Single(Directory.GetFiles(Path.Combine(root, "outside")));
        Directory.Delete(destination);
        Directory.CreateDirectory(destination);
        var id = Guid.NewGuid().ToString();
        var orphan = Path.Combine(destination, id + ".zip"); File.WriteAllText(orphan, "retain existing backup");
        Assert.Throws<IOException>(() => CoreStateSnapshot.Create(root, id));
        Assert.Equal("retain existing backup", File.ReadAllText(orphan));
    }
    public void Dispose() => Directory.Delete(root, true);
}
