namespace Haas.Hosty.Core;

/// <summary>Portable package metadata; Hosty provenance never changes SKILL.md.</summary>
internal sealed record AgentSkillInfo(string Id, string Name, string Description, string SourceKind,
    string? AppId, string? AppVersion, string? Repository, string? Ref, string Path, string? Commit,
    int FileCount, long Bytes, DateTimeOffset InstalledAt, string? CoreVersion = null, string? IntroductionPath = null);
internal sealed record AgentSkillFile(string Path, byte[] Content, bool Executable = false);
internal sealed record AgentSkillPackage(string Name, string Description, AgentSkillFile[] Files);
internal sealed record AgentSkillEntry(AgentSkillInfo Info, AgentSkillFile[] Files, SourceReadGrant? SourceGrant = null);
internal sealed record AgentSkillExport(string Id, string Owner, string[] SkillIds);
internal sealed record AgentSkillLibraryState(AgentSkillEntry[] Skills, AgentSkillExport[] Exports)
{
    public static AgentSkillLibraryState Empty => new([], []);
}
internal sealed record AgentSkillCatalog(AgentSkillInfo[] Skills);
internal sealed record AgentSkillContent(AgentSkillInfo Skill, string Path, byte[] Content, string[] Files);
internal sealed record AgentSkillGitRequest(string Repository, string Ref = "HEAD", string Path = "", string? ConnectionId = null);
internal sealed record AgentSkillCandidate(string Path, string Name, string Description, int FileCount, long Bytes);
internal sealed record AgentSkillDiscovery(string Repository, string Ref, string Commit, AgentSkillCandidate[] Skills);
internal sealed record AgentSkillInstallRequest(AgentSkillGitRequest Source, string Commit, string[] Paths);
internal sealed record AgentSkillMetadata(string Path, string Name, string Description);
internal sealed record AgentSkillSelectionRequest(AgentSkillGitRequest Source, string[] Names);
internal sealed record AgentSkillSelectedInstallRequest(AgentSkillGitRequest Source, string Commit, string[] Names);
internal sealed record AgentSkillSelection(string Repository, string Ref, string Commit, AgentSkillMetadata[] Skills);
internal sealed record AgentSkillUpdateRequest(string[] SkillIds);
internal sealed record AgentSkillUpdate(string Id, string? CurrentCommit, string? AvailableCommit, bool Removed, string? Error = null);
internal sealed record AgentSkillUpdates(AgentSkillUpdate[] Skills);
internal sealed record AgentSkillExportRequest(string ContextId, string[] SkillIds, bool IncludePlatform = false);
internal sealed record AgentPlatformIntroduction(string SkillId, string CoreVersion, string Path, string Text);
internal sealed record AgentSkillExportResult(string Id, string Path, AgentSkillInfo[] Skills, AgentPlatformIntroduction? PlatformIntroduction = null);
