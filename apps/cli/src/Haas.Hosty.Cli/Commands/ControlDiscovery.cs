namespace Haas.Hosty.Cli.Commands;

// Shared helpers for the loopback control-plane discovery file ({root}/core/run/control.json).
internal static class ControlDiscovery
{
    // Best-effort removal of a stale/orphaned discovery file (one left by a hard-killed Core). A
    // file we cannot delete is harmless — the next Core start overwrites it (FileMode.Create).
    public static void TryDeleteStale(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }
}
