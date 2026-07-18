using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

// Tightens permissions on Core-owned files that older versions created with ordinary umask modes
// (app state, backup archives, runtime logs, the audit log). New writes are already owner-only; this
// exists so an upgrade does not leave an installation's history readable to every local OS user.
//
// Deliberately narrow: it never touches apps/<id>/data. Those trees are bind-mounted into containers
// that may run as a different uid — and some are intentionally group/world-writable so a non-root
// collector can write through the mount — so tightening them would break apps rather than harden them.
internal sealed class CoreFilePermissionMigration(
    CoreDataPaths paths,
    ILogger<CoreFilePermissionMigration> logger) : IHostedService
{
    private const UnixFileMode OwnerOnlyFileMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
    private const UnixFileMode OwnerOnlyDirectoryMode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (OperatingSystem.IsWindows())
        {
            return Task.CompletedTask;
        }

        try
        {
            var tightened = Migrate();
            if (tightened > 0)
            {
                logger.LogInformation("Restricted permissions on {Count} pre-existing Core-owned file(s)/directory(ies).", tightened);
            }
        }
        catch (Exception ex)
        {
            // Never block startup on a permission sweep; the paths that matter are already written
            // owner-only from here on.
            logger.LogWarning(ex, "Core file permission migration did not complete.");
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private int Migrate()
    {
        var tightened = 0;

        var auditDirectory = Path.GetDirectoryName(paths.AuditLogPath);
        if (!string.IsNullOrWhiteSpace(auditDirectory))
        {
            tightened += RestrictDirectory(auditDirectory);
        }

        tightened += RestrictFile(paths.AuditLogPath);
        tightened += RestrictDirectory(paths.BackupsRoot);

        foreach (var appBackupRoot in EnumerateDirectories(paths.BackupsRoot))
        {
            tightened += RestrictDirectory(appBackupRoot);
            foreach (var file in EnumerateFiles(appBackupRoot))
            {
                tightened += RestrictFile(file);
            }
        }

        foreach (var appRoot in EnumerateDirectories(paths.AppsRoot))
        {
            tightened += RestrictFile(Path.Combine(appRoot, "state.json"));

            var logsRoot = Path.Combine(appRoot, "logs");
            tightened += RestrictDirectory(logsRoot);
            foreach (var file in EnumerateFiles(logsRoot))
            {
                tightened += RestrictFile(file);
            }
        }

        return tightened;
    }

    private static IEnumerable<string> EnumerateDirectories(string root)
        => Directory.Exists(root) ? Directory.EnumerateDirectories(root) : [];

    private static IEnumerable<string> EnumerateFiles(string root)
        => Directory.Exists(root) ? Directory.EnumerateFiles(root) : [];

    private static int RestrictFile(string path)
        => Restrict(path, OwnerOnlyFileMode, File.Exists);

    private static int RestrictDirectory(string path)
        => Restrict(path, OwnerOnlyDirectoryMode, Directory.Exists);

    private static int Restrict(string path, UnixFileMode target, Func<string, bool> exists)
    {
        if (!exists(path))
        {
            return 0;
        }

        try
        {
            if (File.GetUnixFileMode(path) == target)
            {
                return 0;
            }

            File.SetUnixFileMode(path, target);
            return 1;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // A file Core cannot chmod (foreign owner, read-only mount) is left as-is.
            return 0;
        }
    }
}
