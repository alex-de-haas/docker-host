namespace Haas.Hosty.Cli.Commands;

// The app's health as Core last observed it (app-readiness), as the CLI reads it off an app summary:
// the per-app fold for display, and per-service liveness + probe results for any decision about an
// endpoint — an MCP interface is called only when the service that serves it answers, never when the
// app-level fold merely says the app is healthy. Shared by the commands that carry it, and registered
// in each command's own source-generated JSON context.
internal sealed record AppHealthSummary(string Status, IReadOnlyList<AppServiceHealthSummary> Services);

internal sealed record AppServiceHealthSummary(string Service, string Status, string? Health = null);
