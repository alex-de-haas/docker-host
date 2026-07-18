namespace Haas.Hosty.Core;

internal static class SecureFileSystem
{
    private const UnixFileMode OwnerOnlyDirectoryMode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
    private const UnixFileMode OwnerOnlyFileMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;

    public static void EnsurePrivateDirectory(string path)
    {
        Directory.CreateDirectory(path);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path, OwnerOnlyDirectoryMode);
        }
    }

    public static FileStream CreatePrivateFile(string path, FileMode mode)
        => CreatePrivateFile(path, mode, FileShare.None);

    // `share` exists for append-style files that a reader opens concurrently (runtime logs are
    // tailed while the process writing them still holds the handle). UnixCreateMode only applies
    // when this call creates the file; an existing file keeps its mode, which is what the startup
    // migration is for.
    public static FileStream CreatePrivateFile(string path, FileMode mode, FileShare share)
    {
        var options = new FileStreamOptions
        {
            Mode = mode,
            Access = FileAccess.Write,
            Share = share,
            BufferSize = 4096,
            Options = FileOptions.Asynchronous,
        };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = OwnerOnlyFileMode;
        }

        return new FileStream(path, options);
    }

    public static void TryRestrictFile(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        try
        {
            File.SetUnixFileMode(path, OwnerOnlyFileMode);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Permissions stay best-effort for files created by older versions.
        }
    }

    // Best-effort counterpart of TryRestrictFile for directories Core owns outright. Never call this
    // on a directory an app runtime has to traverse — app data roots are bind-mounted into containers
    // that may run as a different uid, so tightening those would break the mount, not harden it.
    public static void TryRestrictDirectory(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        try
        {
            File.SetUnixFileMode(path, OwnerOnlyDirectoryMode);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Permissions stay best-effort for directories created by older versions.
        }
    }
}
