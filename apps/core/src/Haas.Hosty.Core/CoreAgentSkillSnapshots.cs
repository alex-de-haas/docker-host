namespace Haas.Hosty.Core;

internal sealed record CoreAgentSkillSelection(string SkillId, string? ExpectedDigest = null);
internal sealed record CoreAgentSkillRequest(string AdmissionRef, string RequestId, CoreAgentSkillSelection[] Skills,
    string? ConfigurationId = null);
internal sealed record CoreAgentPinnedSkill(string SkillId, string Digest);
internal sealed record CoreAgentSkillSnapshot(string Id, string Path, string Digest, CoreAgentPinnedSkill[] Skills);
internal sealed record CoreAgentSkillSnapshotEntry(string Fingerprint, CoreAgentSkillSnapshot Snapshot);

internal sealed partial class CoreAgentExecution
{
    internal async Task<CoreAgentSkillSnapshot> Skills(AppRecord provider, CoreAgentSkillRequest input, CancellationToken ct)
    {
        var (record, origin) = await ValidateRecord(provider, await store.Get(input.AdmissionRef, ct), ct, admitted: false);
        if (record.Request.Operation is not ("sessions.create" or "sessions.configure" or "runs.start")
            || !Guid.TryParse(input.RequestId, out _) || input.Skills is null || input.Skills.Length > 202
            || input.Skills.Any(s => string.IsNullOrWhiteSpace(s.SkillId))
            || input.Skills.Select(s => s.SkillId).Distinct(StringComparer.Ordinal).Count() != input.Skills.Length)
            throw Invalid("Pin a bounded skill selection for this session or configuration.");
        // A retained task delegates the configured executor; there is no invented Core skills
        // scope for an external task API client. Its exact task actor is already revalidated.
        if (record.Authority is null) origin.Require("", CoreAppPermissions.ReadSkills);
        var consumer = await apps.GetAppAsync(record.CallerAppId, ct);
        if (consumer is null || !AppManagementAuthorization.HasPermission(consumer, CoreAppPermissions.ReadSkills))
            throw new AppIdentityException("app_permission_required", "The consumer requires reviewed skill library access.");
        var context = string.Join("\n", provider.Id, PanelIdentity.Installation(provider), record.CallerAppId,
            record.CallerInstallation.ToString("O"), record.UserId, record.Request.SessionId, input.ConfigurationId, input.RequestId);
        return await skills.SnapshotAsync("app:" + provider.Id, context, input.Skills, ct);
    }
}

internal sealed partial class AgentSkillLibrary
{
    internal static string ContentDigest(AgentSkillEntry entry) => Id(CoreJson.Text(entry.Files.OrderBy(f => f.Path, StringComparer.Ordinal).ToArray()));
    internal async Task<CoreAgentSkillSnapshot> SnapshotAsync(string owner, string context, CoreAgentSkillSelection[] selection, CancellationToken ct)
    {
        var id = Id("snapshot", context);
        var fingerprint = Id(CoreJson.Text(selection));
        var destination = ExportPath(new(id, owner, []));
        var metadata = Path.Combine(destination, ".hosty-snapshot.json");
        await gate.WaitAsync(ct);
        try
        {
            var previous = await JsonStorage.ReadAsync<CoreAgentSkillSnapshotEntry>(metadata, ct);
            if (previous is not null)
            {
                if (previous.Fingerprint != fingerprint) throw new AppLifecycleException("request_conflict", "Reuse the original snapshot request and selection.");
                await RequireInstalledLockedAsync(selection, ct);
                return previous.Snapshot;
            }
            var state = await ReadAsync(ct);
            var entries = selection.Select(s => state.Skills.SingleOrDefault(e => e.Info.Id == s.SkillId)
                ?? throw new AppLifecycleException("skill_not_found", "A selected skill is no longer installed.")).ToArray();
            if (entries.Select(e => e.Info.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count() != entries.Length)
                throw new AppLifecycleException("skill_name_conflict", "Selected native skill names must be unique.");
            var pinned = entries.Select(e => new CoreAgentPinnedSkill(e.Info.Id, ContentDigest(e))).ToArray();
            foreach (var requested in selection.Where(s => s.ExpectedDigest is not null))
                if (pinned.Single(p => p.SkillId == requested.SkillId).Digest != requested.ExpectedDigest)
                    throw new AppLifecycleException("skill_source_changed", "A selected skill changed; review the current content before pinning it.");
            var export = new AgentSkillExport(id, owner, selection.Select(s => s.SkillId).ToArray());
            var stage = await PrepareExportAsync(state, export, ct);
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                var snapshot = new CoreAgentSkillSnapshot(id, destination, Id(CoreJson.Text(pinned)), pinned);
                await JsonStorage.WriteOwnerFileAsync(Path.Combine(stage, ".hosty-snapshot.json"), new CoreAgentSkillSnapshotEntry(fingerprint, snapshot), ct);
                Directory.Move(stage, destination);
                return snapshot;
            }
            finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
        }
        finally { gate.Release(); }
    }
}
