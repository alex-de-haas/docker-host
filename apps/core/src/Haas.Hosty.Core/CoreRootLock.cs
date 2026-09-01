namespace Haas.Hosty.Core;

using System.Diagnostics;
using System.Text;
using System.Text.Json;

// One Core process per data root, enforced before the listener binds. Ports cannot guard this: a
// second start against a live root with a different port would bind happily and then share the
// root's databases, settings and instance identity. The guard is an OS file lock on a dedicated
// lock file, opened OpenOrCreate and held with FileShare.None for the process lifetime. The OS
// releases the lock when the holder dies — a hard kill included — so a leftover lock FILE is simply
// reopened; there is no stale-lock state to recover. The file carries the holder PID purely as a
// human diagnostic; the authoritative live-instance answer comes from the root's control.json.
internal sealed class CoreRootLock : IDisposable
{
    public const string LockFileName = "core.lock";

    private readonly FileStream stream;

    private CoreRootLock(FileStream stream, string lockPath)
    {
        this.stream = stream;
        LockPath = lockPath;
    }

    public string LockPath { get; }

    public static string BuildLockPath(string runDirectory) => Path.Combine(runDirectory, LockFileName);

    // Takes the per-root exclusive lock, creating the run directory as needed. A refused second
    // start — same root, ANY port — must name the live instance (root, PID and endpoint from the
    // root's discovery file) rather than bind alongside it or die on a bare sharing violation. The
    // discovery file's PID is what tells a live Core apart from a holder that has not written
    // discovery yet (a Core still starting up).
    public static CoreRootLock Acquire(HostyCoreRuntimeConfig config)
    {
        var lockPath = BuildLockPath(config.RunDirectory);
        try
        {
            SecureFileSystem.EnsurePrivateDirectory(config.RunDirectory);
            var stream = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            WriteHolderPid(stream);
            return new CoreRootLock(stream, lockPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new CoreRootLockedException(BuildRefusalMessage(config, lockPath), ex);
        }
    }

    private static void WriteHolderPid(FileStream stream)
    {
        try
        {
            stream.SetLength(0);
            stream.Write(Encoding.UTF8.GetBytes($"pid {Environment.ProcessId}\n"));
            stream.Flush();
        }
        catch (IOException)
        {
            // Diagnostic content only — holding the lock is what matters.
        }
    }

    private static string BuildRefusalMessage(HostyCoreRuntimeConfig config, string lockPath)
    {
        if (TryReadLiveInstance(config.ControlDiscoveryPath) is { } live)
        {
            return $"Hosty Core is already running for data root '{config.DataRoot}' " +
                $"(PID {live.ProcessId}, endpoint {live.Endpoint}). One Core process per data root: " +
                "stop it with `hosty core stop`, or point this start at a different root with --data-root.";
        }

        return $"Another process holds the Hosty Core root lock '{lockPath}' for data root " +
            $"'{config.DataRoot}' — most likely a Core that is still starting. One Core process per " +
            "data root: stop it, or point this start at a different root with --data-root.";
    }

    // The live instance recorded in the root's control.json, or null when the file is absent,
    // unreadable, or names a PID that is no longer alive (a discovery file orphaned by a hard kill
    // says nothing about who holds the lock now).
    private static (int ProcessId, string Endpoint)? TryReadLiveInstance(string discoveryPath)
    {
        try
        {
            using var file = new FileStream(discoveryPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            var discovery = JsonSerializer.Deserialize(file, CoreJsonSerializerContext.Default.ControlDiscoveryDocument);
            if (discovery is not { ProcessId: > 0 } || !IsProcessAlive(discovery.ProcessId))
            {
                return null;
            }

            return (discovery.ProcessId, string.IsNullOrWhiteSpace(discovery.Endpoint) ? discovery.ControlBaseUrl : discovery.Endpoint);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    // Same stance as the CLI's ProcessLiveness: ArgumentException is the documented "no such
    // process" signal; any other failure is indeterminate and must count as alive so a probe error
    // never hides a live instance from the refusal message.
    private static bool IsProcessAlive(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (Exception)
        {
            return true;
        }
    }

    public void Dispose() => stream.Dispose();
}

// The per-root lock is held by another process; the message names the live instance when the root's
// discovery file identifies one.
internal sealed class CoreRootLockedException(string message, Exception innerException)
    : Exception(message, innerException);
