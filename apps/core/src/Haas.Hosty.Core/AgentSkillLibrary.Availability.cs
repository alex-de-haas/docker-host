namespace Haas.Hosty.Core;

internal sealed partial class AgentSkillLibrary
{
    // Only logical availability is cached. Every caller's current permissions are still validated
    // by the admission bridge; pinned package bytes and digests never change on a cache refresh.
    private HashSet<string>? availableIds;
    private (bool Exists, long Length, long Modified) availabilityStamp;
    private (bool Exists, long Length, long Modified) AvailabilityStamp()
    {
        var file = new FileInfo(StatePath);
        return file.Exists ? (true, file.Length, file.LastWriteTimeUtc.Ticks) : (false, 0, 0);
    }
    private void InvalidateAvailability() => availableIds = null;
    private void CacheAvailability(AgentSkillLibraryState state)
    {
        availableIds = state.Skills.Select(s => s.Info.Id).ToHashSet(StringComparer.Ordinal);
        availabilityStamp = AvailabilityStamp();
    }
    // The library gate protects this index and all publication paths. External owner-file changes
    // also invalidate by metadata revision; a normal renewal does not decode 64 MiB of content.
    private async Task RequireInstalledLockedAsync(CoreAgentSkillSelection[] selection, CancellationToken ct)
    {
        if (availableIds is null || availabilityStamp != AvailabilityStamp()) await ReadAsync(ct);
        if (selection.Any(s => !availableIds!.Contains(s.SkillId)))
            throw new AppLifecycleException("skill_not_found", "A selected skill is no longer installed.");
    }
}
