namespace Haas.Hosty.Core;

/// <summary>Removes a verified Core-owned directory without following Windows reparse points.</summary>
internal static class CoreOwnedDirectoryCleanup
{
    // The caller verifies ownership and the root path before calling this helper.
    internal static void Delete(string path, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        if (!Directory.Exists(path)) return;
        if (OperatingSystem.IsWindows()) DeleteWindowsEntry(new DirectoryInfo(path), ct);
        else Directory.Delete(path, recursive: true);
    }

    private static void DeleteWindowsEntry(FileSystemInfo entry, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var attributes = entry.Attributes;
        // Delete links themselves without traversing or changing their targets. Removing a
        // junction directly also avoids recursive Directory.Delete's volume-unmount handling.
        if ((attributes & FileAttributes.ReparsePoint) == 0)
        {
            if (entry is DirectoryInfo directory)
                foreach (var child in directory.EnumerateFileSystemInfos()) DeleteWindowsEntry(child, ct);
            if ((attributes & FileAttributes.ReadOnly) != 0)
                entry.Attributes = attributes & ~FileAttributes.ReadOnly;
        }
        entry.Delete();
    }
}
