using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreFilePermissionTests
{
    private const UnixFileMode OwnerOnlyFile = UnixFileMode.UserRead | UnixFileMode.UserWrite;
    private const UnixFileMode OwnerOnlyDirectory = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
    private const UnixFileMode WorldReadableFile = OwnerOnlyFile | UnixFileMode.GroupRead | UnixFileMode.OtherRead;
    private const UnixFileMode WorldReadableDirectory =
        OwnerOnlyDirectory | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute;

    [Fact]
    public async Task AppendAsync_WritesAuditLogOwnerOnly()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var paths = CreatePaths(CreateRoot());
        var store = new AuditStore(paths);

        await store.AppendAsync(CreateAuditRecord("first"));
        await store.AppendAsync(CreateAuditRecord("second"));

        Assert.Equal(OwnerOnlyFile, File.GetUnixFileMode(paths.AuditLogPath));
        Assert.Equal(OwnerOnlyDirectory, File.GetUnixFileMode(Path.GetDirectoryName(paths.AuditLogPath)!));
        // Appending twice must not truncate: FileMode.Append plus a private create mode still appends.
        var records = await store.ReadRecentAsync();
        Assert.Equal(2, records.Count);
    }

    [Fact]
    public async Task Migration_TightensLegacyFilesLeftByOlderVersions()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var root = CreateRoot();
        var paths = CreatePaths(root);
        var appRoot = Path.Combine(paths.AppsRoot, "com.example.notes");
        var logsRoot = Path.Combine(appRoot, "logs");
        var backupRoot = Path.Combine(paths.BackupsRoot, "com.example.notes");
        var auditRoot = Path.GetDirectoryName(paths.AuditLogPath)!;

        var statePath = Path.Combine(appRoot, "state.json");
        var logPath = Path.Combine(logsRoot, "web.log");
        var archivePath = Path.Combine(backupRoot, "20260718_manual.zip");
        var metadataPath = Path.Combine(backupRoot, "20260718_manual.json");

        foreach (var directory in new[] { appRoot, logsRoot, backupRoot, auditRoot })
        {
            Directory.CreateDirectory(directory);
            File.SetUnixFileMode(directory, WorldReadableDirectory);
        }

        foreach (var file in new[] { statePath, logPath, archivePath, metadataPath, paths.AuditLogPath })
        {
            await File.WriteAllTextAsync(file, "legacy");
            File.SetUnixFileMode(file, WorldReadableFile);
        }

        await new CoreFilePermissionMigration(paths, NullLogger<CoreFilePermissionMigration>.Instance)
            .StartAsync(CancellationToken.None);

        Assert.Equal(OwnerOnlyFile, File.GetUnixFileMode(statePath));
        Assert.Equal(OwnerOnlyFile, File.GetUnixFileMode(logPath));
        Assert.Equal(OwnerOnlyFile, File.GetUnixFileMode(archivePath));
        Assert.Equal(OwnerOnlyFile, File.GetUnixFileMode(metadataPath));
        Assert.Equal(OwnerOnlyFile, File.GetUnixFileMode(paths.AuditLogPath));
        Assert.Equal(OwnerOnlyDirectory, File.GetUnixFileMode(logsRoot));
        Assert.Equal(OwnerOnlyDirectory, File.GetUnixFileMode(backupRoot));
        Assert.Equal(OwnerOnlyDirectory, File.GetUnixFileMode(auditRoot));
    }

    [Fact]
    public async Task Migration_LeavesBindMountedAppDataAlone()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        // apps/<id>/data is mounted into containers that may run as another uid, and system-app
        // telemetry directories are deliberately group/world-writable so a non-root collector can
        // write through the mount. Tightening either would break the app, not protect it.
        var root = CreateRoot();
        var paths = CreatePaths(root);
        var appRoot = Path.Combine(paths.AppsRoot, "com.example.notes");
        var dataRoot = Path.Combine(appRoot, "data");
        var dataFile = Path.Combine(dataRoot, "library.db");

        Directory.CreateDirectory(dataRoot);
        await File.WriteAllTextAsync(dataFile, "rows");
        File.SetUnixFileMode(dataRoot, WorldReadableDirectory | UnixFileMode.GroupWrite | UnixFileMode.OtherWrite);
        File.SetUnixFileMode(dataFile, WorldReadableFile);
        File.SetUnixFileMode(appRoot, WorldReadableDirectory);

        await new CoreFilePermissionMigration(paths, NullLogger<CoreFilePermissionMigration>.Instance)
            .StartAsync(CancellationToken.None);

        Assert.Equal(
            WorldReadableDirectory | UnixFileMode.GroupWrite | UnixFileMode.OtherWrite,
            File.GetUnixFileMode(dataRoot));
        Assert.Equal(WorldReadableFile, File.GetUnixFileMode(dataFile));
        // The app root itself stays traversable so a container uid can still reach data/.
        Assert.Equal(WorldReadableDirectory, File.GetUnixFileMode(appRoot));
    }

    [Fact]
    public async Task Migration_SurvivesMissingDataRoot()
    {
        var paths = CreatePaths(Path.Combine(Path.GetTempPath(), $"hosty-core-perm-missing-{Guid.NewGuid():N}"));

        await new CoreFilePermissionMigration(paths, NullLogger<CoreFilePermissionMigration>.Instance)
            .StartAsync(CancellationToken.None);
    }

    private static string CreateRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-perm-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        return root;
    }

    private static CoreDataPaths CreatePaths(string root)
        => new(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));

    private static AuditRecord CreateAuditRecord(string id) => new(
        Id: id,
        Action: "app.install",
        ResourceType: "app",
        ResourceId: "com.example.notes",
        Outcome: "ok",
        ActorUserId: "user_1",
        CreatedAt: DateTimeOffset.UnixEpoch,
        Details: new Dictionary<string, string>());
}
