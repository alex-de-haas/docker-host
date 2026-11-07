namespace Haas.Hosty.Core;

internal sealed record StorageRefreshRequest(string RequestId);
internal sealed record StorageUsageState(StorageUsageSnapshot? Snapshot, bool IsScanning, string? LastError);
internal sealed record StorageDiskCapacity(long TotalBytes, long AvailableBytes);
internal sealed record StorageUsageIssue(string RelativePath, string Code);
internal sealed record StorageUsagePart(string Id, long? AllocatedBytes, long LogicalBytes);
internal sealed record StorageUsageCategory(string Id, long? AllocatedBytes, long LogicalBytes, bool Partial);
internal sealed record StorageUsageResource(string Id, string Category, string Kind, string Label,
    string RelativePath, long? AllocatedBytes, long LogicalBytes, bool Partial, string? AppId,
    string[] RelatedAppIds, string? WorkspaceId, string? WorktreeId, StorageUsagePart[] Parts);
internal sealed record StorageUsageSnapshot(string Id, DateTimeOffset StartedAt, DateTimeOffset MeasuredAt,
    long DurationMs, long? AllocatedBytes, long LogicalBytes, bool Partial, StorageDiskCapacity? Disk,
    StorageUsageCategory[] Categories, StorageUsageResource[] Resources, StorageUsageIssue[] Issues,
    int IssueCount, long ExcludedSymlinkCount, long ExcludedMountCount);
