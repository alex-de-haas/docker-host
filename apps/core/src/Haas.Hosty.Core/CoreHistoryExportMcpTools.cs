using System.ComponentModel;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Haas.Hosty.Core;

[McpServerToolType]
internal sealed class CoreHistoryExportMcpTools(IHttpContextAccessor context, CoreCapabilityAuthorization authorization, CoreHistoryExports exports)
{
    private Task<CoreCapabilityCaller> Caller(string operation, CancellationToken ct)
        => CoreProviderApi.Caller((context.HttpContext ?? throw new AppIdentityException("permission_denied", "A current caller is required.")).Request,
            authorization, "conversation-history", "exports." + operation, ct);
    [McpServerTool(Name = "history_export_create", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Propose a separate indexing consent for an exact consumer and owned source corpus. The owner reviews the returned Core approval page. This call never approves itself; ordinary history access and shared-to-you conversations do not authorize bulk export.")]
    public Task<CallToolResult> Create([Description("Stable request UUID, exact consumer, explicit corpus, purpose and optional expiry.")] CoreHistoryExportCreate input, CancellationToken cancellationToken)
        => CoreProviderResults.Run(async () => await exports.CreateAsync(await Caller("create", cancellationToken), input, cancellationToken));
    [McpServerTool(Name = "history_export_get", ReadOnly = true, Destructive = false)]
    [Description("Inspect an export consent. Its authenticated former consumer receives only a content-free purge status after revocation; a reference alone grants no access.")]
    public Task<CallToolResult> Get([Description("Exact export grant ID.")] CoreHistoryExportGet input, CancellationToken cancellationToken)
        => CoreProviderResults.Run(async () => await exports.GetAsync(await Caller("get", cancellationToken), input.ExportGrantId, cancellationToken));
    [McpServerTool(Name = "history_export_acknowledge", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("As the exact export consumer, acknowledge an issued applied cursor monotonically, or confirm purge after revocation. Acknowledgement cannot approve or reactivate consent. Preserve the request UUID on uncertain outcomes.")]
    public Task<CallToolResult> Acknowledge([Description("Grant, request UUID, expected revision and either issued cursor or purgeComplete.")] CoreHistoryExportAcknowledge input, CancellationToken cancellationToken)
        => CoreProviderResults.Run(async () => await exports.AcknowledgeAsync(await Caller("acknowledge", cancellationToken), input, cancellationToken));
    [McpServerTool(Name = "history_export_snapshot", ReadOnly = true, Destructive = false)]
    [Description("Read a bounded initial source snapshot for the exact owner-approved consumer and corpus. Finish enumeration before acknowledging the high-water change cursor. Current source access is checked on every page.")]
    public Task<CallToolResult> Snapshot([Description("Approved export grant, source provider, optional issued cursor and page size 1–200.")] CoreHistoryExportQuery input, CancellationToken cancellationToken)
        => CoreProviderResults.Run(async () => await exports.BatchAsync(await Caller("snapshot", cancellationToken), input, false, cancellationToken));
    [McpServerTool(Name = "history_export_changes", ReadOnly = true, Destructive = false)]
    [Description("Read source replacements, deletion tombstones and access resets after an exported snapshot. Deduplicate identities/revisions, purge on access_reset and rescan on a cursor gap. No vector database is installed or selected.")]
    public Task<CallToolResult> Changes([Description("Approved export grant, exact provider and change cursor issued for this consumer.")] CoreHistoryExportQuery input, CancellationToken cancellationToken)
        => CoreProviderResults.Run(async () => await exports.BatchAsync(await Caller("changes", cancellationToken), input, true, cancellationToken));
    [McpServerTool(Name = "history_export_revoke", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("As the source owner, revoke an export consent and require its consumer to purge the derived partition. Future content reads stop; copies already delivered cannot be retracted automatically.")]
    public Task<CallToolResult> Revoke([Description("Export grant, stable request UUID and expected current revision.")] CoreHistoryExportRevoke input, CancellationToken cancellationToken)
        => CoreProviderResults.Run(async () => await exports.RevokeAsync(await Caller("revoke", cancellationToken), input, cancellationToken));
}
