namespace Haas.Hosty.Core;

internal sealed partial class AppSourceService
{
    public async Task<AppSourceSummary> GetWorktreeSummaryAsync(string appId, CancellationToken cancellationToken = default)
    {
        var status = await GetWorktreeStatusAsync(appId, cancellationToken);
        return new(status.AppId, status.State, status.ScopePath, status.Branch, status.Head, status.FileCount,
            status.Truncated, status.ObservedAt, status.Error, status.LineStats);
    }
}

internal sealed record AppSourceSummary(string AppId, string State, string? ScopePath, string? Branch, string? Head,
    int FileCount, bool Truncated, DateTimeOffset ObservedAt, string? Error, AppSourceLineStats? LineStats);
