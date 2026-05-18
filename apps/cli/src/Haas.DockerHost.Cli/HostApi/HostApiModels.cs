namespace Haas.DockerHost.Cli.HostApi;

using System.Text.Json;

internal sealed class HostStatusResponse
{
    public JsonElement? Host { get; init; }

    public JsonElement? Docker { get; init; }
}

internal sealed class CliTokenListResponse
{
    public IReadOnlyList<CliTokenSummary> CliTokens { get; init; } = [];
}

internal sealed class CliTokenCreateRequest
{
    public string? Label { get; init; }

    public string? UserId { get; init; }
}

internal sealed class CliTokenRotateRequest
{
    public string? Label { get; init; }
}

internal sealed class CliTokenCreateResponse
{
    public CliTokenSummary? CliToken { get; init; }

    public string Token { get; init; } = "";

    public string? RevokedTokenId { get; init; }
}

internal sealed class CliTokenRevokeResponse
{
    public bool Revoked { get; init; }

    public string TokenId { get; init; } = "";
}

internal sealed class CliTokenSummary
{
    public string Id { get; init; } = "";

    public string UserId { get; init; } = "";

    public string Label { get; init; } = "";

    public string CreatedAt { get; init; } = "";

    public string? LastUsedAt { get; init; }

    public string? RevokedAt { get; init; }

    public string Scope { get; init; } = "";
}

internal sealed class ModuleListResponse
{
    public IReadOnlyList<ModuleSummary> Modules { get; init; } = [];
}

internal sealed class ModuleSummary
{
    public string Id { get; init; } = "";

    public string Name { get; init; } = "";

    public string? Description { get; init; }

    public string Version { get; init; } = "";

    public string MetadataUrl { get; init; } = "";

    public ModuleImage? Image { get; init; }

    public string OperationStatus { get; init; } = "";

    public ModuleRuntimeStatus? RuntimeStatus { get; init; }

    public string? InstalledAt { get; init; }

    public string? UpdatedAt { get; init; }

    public ModuleOperationError? LastError { get; init; }
}

internal sealed class ModuleImage
{
    public string Repository { get; init; } = "";

    public string Tag { get; init; } = "";

    public string Reference { get; init; } = "";

    public string? PullPolicy { get; init; }
}

internal sealed class ModuleRuntimeStatus
{
    public string State { get; init; } = "";

    public string? ContainerId { get; init; }

    public string ContainerName { get; init; } = "";

    public string? StartedAt { get; init; }

    public string? FinishedAt { get; init; }

    public string? Error { get; init; }
}

internal sealed class ModuleOperationError
{
    public string? Operation { get; init; }

    public int? HttpStatus { get; init; }

    public int? DockerStatusCode { get; init; }

    public string? DockerMessage { get; init; }

    public string Message { get; init; } = "";

    public string? NextStep { get; init; }

    public string? OccurredAt { get; init; }
}

internal sealed class ModuleActionResult
{
    public bool Success { get; init; }

    public ModuleSummary? Module { get; init; }

    public ModuleOperationError? Error { get; init; }
}

internal sealed class InstallPlanResponse
{
    public InstallPlan? Plan { get; init; }

    public InstallPlanErrorEnvelope? Error { get; init; }
}

internal sealed class InstallPlanErrorEnvelope
{
    public string Code { get; init; } = "";

    public string Message { get; init; } = "";

    public IReadOnlyList<InstallPlanValidationError> ValidationErrors { get; init; } = [];

    public IReadOnlyList<InstallPlanConflict> Conflicts { get; init; } = [];
}

internal sealed class InstallPlanValidationError
{
    public string Code { get; init; } = "";

    public string Message { get; init; } = "";

    public string Path { get; init; } = "";

    public string? Node { get; init; }
}

internal sealed class InstallPlanConflict
{
    public string Code { get; init; } = "";

    public string Message { get; init; } = "";

    public string ResourceType { get; init; } = "";

    public string ResourceId { get; init; } = "";

    public string Path { get; init; } = "";

    public string? Node { get; init; }

    public JsonElement? ExistingValue { get; init; }

    public JsonElement? ProposedValue { get; init; }
}

internal sealed class InstallPlan
{
    public string MetadataUrl { get; init; } = "";

    public string MetadataDigest { get; init; } = "";

    public string PlanDigest { get; init; } = "";

    public InstallPlanModule Module { get; init; } = new();

    public IReadOnlyList<InstallPlanDependencyNode> Dependencies { get; init; } = [];

    public IReadOnlyList<string> InstallOrder { get; init; } = [];

    public IReadOnlyList<InstallPlanImage> Images { get; init; } = [];

    public IReadOnlyList<InstallPlanSettingPrompt> Settings { get; init; } = [];

    public InstallPlanStorage Storage { get; init; } = new();

    public InstallPlanRuntime Runtime { get; init; } = new();

    public InstallPlanDocker Docker { get; init; } = new();

    public IReadOnlyList<InstallPlanConflict> Conflicts { get; init; } = [];
}

internal sealed class InstallPlanModule
{
    public string Id { get; init; } = "";

    public string Name { get; init; } = "";

    public string? Description { get; init; }

    public string Version { get; init; } = "";
}

internal sealed class InstallPlanDependencyNode
{
    public string Id { get; init; } = "";

    public string Name { get; init; } = "";

    public string Version { get; init; } = "";

    public string MetadataUrl { get; init; } = "";

    public IReadOnlyList<string> RequiredBy { get; init; } = [];

    public string InstallAction { get; init; } = "";

    public InstallPlanNodeDocker Docker { get; init; } = new();
}

internal sealed class InstallPlanNodeDocker
{
    public string ContainerName { get; init; } = "";

    public string NetworkAlias { get; init; } = "";
}

internal sealed class InstallPlanImage
{
    public string ModuleId { get; init; } = "";

    public string Repository { get; init; } = "";

    public string Tag { get; init; } = "";

    public string Reference { get; init; } = "";

    public string PullPolicy { get; init; } = "";
}

internal sealed class InstallPlanSettingPrompt
{
    public string ModuleId { get; init; } = "";

    public string Key { get; init; } = "";

    public string Type { get; init; } = "";

    public bool Required { get; init; }

    public InstallPlanSettingTarget Target { get; init; } = new();

    public JsonElement? Default { get; init; }

    public bool Secret { get; init; }

    public bool Redacted { get; init; }
}

internal sealed class InstallPlanSettingTarget
{
    public string Type { get; init; } = "";

    public string Name { get; init; } = "";
}

internal sealed class InstallPlanStorage
{
    public IReadOnlyList<InstallPlanStorageDirectory> Directories { get; init; } = [];

    public IReadOnlyList<InstallPlanMountCollection> MountCollections { get; init; } = [];
}

internal sealed class InstallPlanStorageDirectory
{
    public string ModuleId { get; init; } = "";

    public string Key { get; init; } = "";

    public string ContainerPath { get; init; } = "";

    public string HostPath { get; init; } = "";

    public bool Required { get; init; }

    public bool Writable { get; init; }

    public bool ReadOnly { get; init; }
}

internal sealed class InstallPlanMountCollection
{
    public string ModuleId { get; init; } = "";

    public string Key { get; init; } = "";

    public string? Label { get; init; }

    public bool Required { get; init; }

    public int MinItems { get; init; }

    public int? MaxItems { get; init; }

    public bool Writable { get; init; }

    public string ItemContainerPathTemplate { get; init; } = "";
}

internal sealed class InstallPlanRuntime
{
    public IReadOnlyList<InstallPlanRuntimePort> Ports { get; init; } = [];
}

internal sealed class InstallPlanRuntimePort
{
    public string Key { get; init; } = "";

    public int ContainerPort { get; init; }

    public string Protocol { get; init; } = "";

    public bool Public { get; init; }
}

internal sealed class InstallPlanDocker
{
    public string NetworkName { get; init; } = "";

    public string ContainerName { get; init; } = "";

    public IReadOnlyList<string> NetworkAliases { get; init; } = [];

    public bool ReplacementRequired { get; init; }

    public IReadOnlyList<string> ReplacementReasons { get; init; } = [];
}

internal sealed class ModuleInstallRequest
{
    public string MetadataUrl { get; init; } = "";

    public string PlanDigest { get; init; } = "";

    public IReadOnlyList<ModuleInstallSettingSelection> Settings { get; init; } = [];

    public IReadOnlyList<ModuleInstallExternalMountSelection> ExternalMounts { get; init; } = [];
}

internal sealed class ModuleInstallSettingSelection
{
    public string ModuleId { get; init; } = "";

    public string Key { get; init; } = "";

    public object? Value { get; init; }

    public bool Secret { get; init; }
}

internal sealed class ModuleInstallExternalMountSelection
{
    public string ModuleId { get; init; } = "";

    public string CollectionKey { get; init; } = "";

    public string Key { get; init; } = "";

    public string? Label { get; init; }

    public string HostPath { get; init; } = "";

    public string ContainerPath { get; init; } = "";

    public string Access { get; init; } = "";
}

internal sealed class ModuleInstallResponse
{
    public ModuleSummary? Module { get; init; }

    public IReadOnlyList<string> InstalledModuleIds { get; init; } = [];

    public IReadOnlyList<string> ReusedModuleIds { get; init; } = [];

    public InstallPlanErrorEnvelope? Error { get; init; }
}

internal sealed class ModuleUpdatePlanResponse
{
    public ModuleUpdatePlan? Plan { get; init; }

    public InstallPlanErrorEnvelope? Error { get; init; }
}

internal sealed class ModuleUpdatePlan
{
    public string ModuleId { get; init; } = "";

    public string MetadataUrl { get; init; } = "";

    public string? CurrentMetadataDigest { get; init; }

    public string RefreshedMetadataDigest { get; init; } = "";

    public string UpdatePlanDigest { get; init; } = "";

    public ModuleUpdateIdentity Module { get; init; } = new();

    public IReadOnlyList<InstallPlanImage> Images { get; init; } = [];

    public IReadOnlyList<InstallPlanSettingPrompt> Settings { get; init; } = [];

    public InstallPlanStorage Storage { get; init; } = new();

    public InstallPlanDocker Docker { get; init; } = new();

    public IReadOnlyList<ModuleUpdateChange> Changes { get; init; } = [];

    public IReadOnlyList<string> Warnings { get; init; } = [];

    public IReadOnlyList<InstallPlanConflict> Conflicts { get; init; } = [];
}

internal sealed class ModuleUpdateIdentity
{
    public string Id { get; init; } = "";

    public string CurrentName { get; init; } = "";

    public string ProposedName { get; init; } = "";

    public string CurrentVersion { get; init; } = "";

    public string ProposedVersion { get; init; } = "";
}

internal sealed class ModuleUpdateChange
{
    public string Category { get; init; } = "";

    public string Action { get; init; } = "";

    public string Title { get; init; } = "";

    public string ModuleId { get; init; } = "";

    public string Path { get; init; } = "";
}

internal sealed class ModuleUpdateRequest
{
    public string UpdatePlanDigest { get; init; } = "";

    public bool Confirmed { get; init; }

    public IReadOnlyList<ModuleInstallSettingSelection> Settings { get; init; } = [];

    public IReadOnlyList<ModuleInstallExternalMountSelection> ExternalMounts { get; init; } = [];
}

internal sealed class ModuleUpdateResponse
{
    public ModuleSummary? Module { get; init; }

    public string? UpdatedModuleId { get; init; }

    public IReadOnlyList<string> InstalledDependencyIds { get; init; } = [];

    public IReadOnlyList<string> ReusedDependencyIds { get; init; } = [];

    public InstallPlanErrorEnvelope? Error { get; init; }
}
