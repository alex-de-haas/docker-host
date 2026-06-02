namespace Haas.Hosty.Core;

internal sealed record CoreDataPaths(
    string DataRoot,
    string CoreRoot,
    string AppsRoot,
    string BackupsRoot,
    string SourcesRoot,
    string AuthRoot,
    string AuditLogPath)
{
    public static CoreDataPaths FromConfig(HostyCoreRuntimeConfig config)
    {
        var coreRoot = Path.Combine(config.DataRoot, "core");
        return new CoreDataPaths(
            config.DataRoot,
            coreRoot,
            Path.Combine(config.DataRoot, "apps"),
            Path.Combine(config.DataRoot, "backups"),
            Path.Combine(config.DataRoot, "sources"),
            Path.Combine(coreRoot, "auth"),
            Path.Combine(coreRoot, "audit", "audit.ndjson"));
    }
}
