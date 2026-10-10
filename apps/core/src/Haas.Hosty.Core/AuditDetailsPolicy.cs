namespace Haas.Hosty.Core;

// Audit is an export surface. New producers must extend a reviewed metadata schema rather than
// serializing request bodies, credentials, runtime settings or exception messages into Details.
internal static class AuditDetailsPolicy
{
    private static readonly HashSet<string> AuthFields = Fields(
        "email role expiresAt invitationId roleChanged revokedSessionCount removedAssignmentCount trigger assignedAppIds " +
        "label kind audience scopes client reason callerAppId targetAppId callingAppId codeAppId channel requestedUser " +
        "existingUser tool retentionDays purged");
    private static readonly HashSet<string> LifecycleFields = Fields("via tool operation operationId");
    private static readonly HashSet<string> ApprovalFields = Fields(
        "requestId caller hostPathChange operation removalOptions assistantTarget assistantAccessEnabled assistantInstructions selectedOptionalPermissions");
    private static readonly HashSet<string> AppReportFields = Fields("sessionId toolName actor deletedBy createdBy autonomy mode waitedMs");
    private static readonly HashSet<string> NotificationFields = Fields("appId recipients status pruned");
    private static readonly HashSet<string> BackupFields = Fields("appId reason planDigest deleted skipped");
    private static readonly HashSet<string> WorkspaceFields = Fields("requestId assistant");
    private static readonly HashSet<string> AgentFields = Fields("offered assistants approvedSkills");

    public static IReadOnlyDictionary<string, string> Constrain(AuditRecord record)
    {
        var fields = record.Action switch
        {
            var action when action.StartsWith("auth.", StringComparison.Ordinal) => AuthFields,
            var action when action.StartsWith("app.lifecycle.", StringComparison.Ordinal) || action == "core.lifecycle.restart" => LifecycleFields,
            "app.installation.approval" or "app.permissions.approval" or "app.mcp.approval" => ApprovalFields,
            var action when action.StartsWith("notification.", StringComparison.Ordinal) => NotificationFields,
            var action when action.StartsWith("backup.", StringComparison.Ordinal) => BackupFields,
            var action when action.StartsWith("development.workspace.", StringComparison.Ordinal) => WorkspaceFields,
            "agent.policy.updated" => AgentFields,
            // Reports cannot claim a Core action: their route permits only an unqualified action name.
            var action when record.Outcome == "reported" && action.StartsWith("app.", StringComparison.Ordinal) => AppReportFields,
            _ => null,
        };
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (fields is null) return result;
        foreach (var (key, value) in record.Details.Take(32))
        {
            if (!fields.Contains(key) || value is null) continue;
            var bounded = value[..Math.Min(value.Length, 4096)];
            if (key == "sessionId")
            {
                // A Core session id is itself a bearer credential. App conversation ids are useful
                // correlation metadata, but their shared name must never become a raw session leak.
                result["sessionFingerprint"] = CoreSessionAuthorization.FingerprintSessionId(bounded);
                continue;
            }
            result[key] = new string(bounded.Where(c => !char.IsControl(c)).ToArray());
        }
        return result;
    }

    private static HashSet<string> Fields(string names) => new(names.Split(' '), StringComparer.Ordinal);
}
