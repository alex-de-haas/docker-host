namespace Haas.Hosty.Core;

/// <summary>Removes Core-owned temporary checkouts, including Git's read-only pack files on Windows.</summary>
internal static class AgentSkillCheckoutCleanup
{
    internal static void Delete(string path)
        => CoreOwnedDirectoryCleanup.Delete(path);
}
