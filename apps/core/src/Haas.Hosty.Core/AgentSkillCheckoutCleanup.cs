namespace Haas.Hosty.Core;

/// <summary>Removes Core-owned temporary checkouts, including Git's read-only pack files on Windows.</summary>
internal static class AgentSkillCheckoutCleanup
{
    internal static void Delete(string path)
    {
        if (!Directory.Exists(path)) return;
        if (OperatingSystem.IsWindows()) DeleteWindowsEntry(new DirectoryInfo(path));
        else Directory.Delete(path, recursive: true);
    }

    private static void DeleteWindowsEntry(FileSystemInfo entry)
    {
        var attributes = entry.Attributes;
        // Delete links themselves without traversing or changing their targets. Removing a
        // junction directly also avoids recursive Directory.Delete's volume-unmount handling.
        if ((attributes & FileAttributes.ReparsePoint) == 0)
        {
            if (entry is DirectoryInfo directory)
                foreach (var child in directory.EnumerateFileSystemInfos()) DeleteWindowsEntry(child);
            if ((attributes & FileAttributes.ReadOnly) != 0)
                entry.Attributes = attributes & ~FileAttributes.ReadOnly;
        }
        entry.Delete();
    }
}
