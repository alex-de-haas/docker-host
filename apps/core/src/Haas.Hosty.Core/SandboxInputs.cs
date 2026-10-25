using System.Text.Json;

namespace Haas.Hosty.Core;

internal interface ISandboxInputs
{
    Task<SandboxResolvedInput> ResolveAsync(SandboxActor actor, SandboxPlanRequest request, CancellationToken ct);
    Task<SandboxResolvedInput> ResolvePinnedAsync(SandboxActor actor, SandboxPlanRequest request, SandboxResolvedInput input, CancellationToken ct)
        => ResolveAsync(actor, request, ct);
    Task AcquireAsync(SandboxInstance instance, CancellationToken ct);
    Task ReleaseAsync(SandboxInstance instance, CancellationToken ct);
    Task ValidateAuthorityAsync(SandboxInstance instance, CancellationToken ct) => Task.CompletedTask;
}

internal sealed class SandboxInputs(AppRegistryStore apps, AppManifestService manifests,
    DevelopmentWorkspaceService workspaces, PrivateSourceService privateSources, IDockerCommandRunner docker) : ISandboxInputs
{
    public async Task ValidateAuthorityAsync(SandboxInstance instance, CancellationToken ct)
    {
        if (instance.Request.Source.WorktreeId is not { } id) return;
        if (instance.Owner.AppId is { } callerId)
        {
            var caller = await apps.GetAppAsync(callerId, ct);
            if (caller is null || !AppManagementAuthorization.HasPermission(caller, CoreAppPermissions.Sources))
                throw new SandboxException("sandbox_source_forbidden", "The creating app's source authority was revoked.", 403);
        }
        var tree = await workspaces.Read(id, null, ct);
        if ((!await workspaces.RequireParticipationSourceAsync(tree, instance.Owner.UserId, ct) && tree.Owner.UserId != instance.Owner.UserId) || tree.State != "active")
            throw new SandboxException("sandbox_source_forbidden", "The bound source is unavailable.", 403);
        await workspaces.WorkspaceGrantAsync(tree, ct);
        var app = await apps.GetAppAsync(instance.Input.AppId, ct);
        if (app?.PrivateSources is { } sources) await privateSources.ValidateAsync(sources, ct);
    }
    public Task<SandboxResolvedInput> ResolveAsync(SandboxActor actor, SandboxPlanRequest request, CancellationToken ct)
        => ResolveCoreAsync(actor, request, null, ct);
    public Task<SandboxResolvedInput> ResolvePinnedAsync(SandboxActor actor, SandboxPlanRequest request, SandboxResolvedInput input, CancellationToken ct)
        => ResolveCoreAsync(actor, request, input, ct);
    private async Task<SandboxResolvedInput> ResolveCoreAsync(SandboxActor actor, SandboxPlanRequest request, SandboxResolvedInput? pinned, CancellationToken ct)
    {
        SandboxValidation.Text(request.AppId, 128, "appId");
        SandboxValidation.Text(request.Profile, 64, "profile");
        var target = await apps.GetAppAsync(request.AppId, ct)
            ?? throw new SandboxException("sandbox_target_not_found", "The selected app is not installed.", 404);
        if (target.ManifestPath is null) throw new SandboxException("sandbox_recipe_unsupported", "The app has no reviewed runtime manifest.");
        var installed = await manifests.LoadAsync(target.ManifestPath, request.Profile, ct, forceRead: true);
        var selection = installed;
        string? source = null;
        switch (request.Source?.Kind)
        {
            case "worktree":
                if (request.Source.WorktreeId is null || request.Source.ArtifactDigest is not null)
                    throw new SandboxException("sandbox_source_invalid", "Choose a registered worktree.", 400);
                if (actor.AppId is { } callerId)
                {
                    var caller = await apps.GetAppAsync(callerId, ct);
                    if (caller is null || !AppManagementAuthorization.HasPermission(caller, CoreAppPermissions.Sources))
                        throw new SandboxException("sandbox_source_forbidden", "Worktree input requires reviewed source authority.", 403);
                }
                var tree = await workspaces.Read(request.Source.WorktreeId, null, ct);
                var sharedSource = await workspaces.RequireParticipationSourceAsync(tree, actor.UserId, ct);
                if ((!sharedSource && tree.Owner.UserId != actor.UserId) || tree.State != "active"
                    || (request.Context?.WorkspaceId is { } workspace && workspace != tree.WorkspaceId))
                    throw new SandboxException("sandbox_source_forbidden", "The source binding is unavailable to this owner.", 403);
                var binding = tree.Apps.SingleOrDefault(a => a.AppId == target.Id && a.Installation == target.InstalledAt)
                    ?? throw new SandboxException("sandbox_source_forbidden", "The app is not bound to this worktree.", 403);
                var grant = await workspaces.WorkspaceGrantAsync(tree, ct);
                if (!sharedSource && grant is not null && grant.OwnerId != actor.UserId)
                    throw new SandboxException("sandbox_source_forbidden", "The source grant belongs to another user.", 403);
                if (target.PrivateSources is { } sources) await privateSources.ValidateAsync(sources, ct);
                await workspaces.ValidateTree(tree, ct);
                source = tree.Path;
                var subpath = string.IsNullOrEmpty(binding.Subpath) ? "manifest.json" : binding.Subpath + "/manifest.json";
                if (!CoreDataPaths.TryResolveContainedRelativePath(source, subpath, out var manifestPath)
                    || CoreDataPaths.ContainsSymbolicLink(source, manifestPath))
                    throw new SandboxException("sandbox_source_invalid", "The manifest must be contained in its registered source.");
                selection = await manifests.LoadAsync(manifestPath, request.Profile, ct, forceRead: true);
                break;
            case "appArtifact":
                if (request.Source.WorktreeId is not null || request.Context?.WorkspaceId is not null)
                    throw new SandboxException("sandbox_source_invalid", "Artifact execution does not allocate or bind a workspace.", 400);
                break;
            default: throw new SandboxException("sandbox_source_invalid", "Choose worktree or appArtifact input.", 400);
        }
        if (selection.Manifest.Id != target.Id || selection.Manifest.Sandbox is not { Protocol: "hosty-sandbox-v1" } contract
            || contract.Roles is not { Length: > 0 and <= 100 } || contract.Roles.Any(string.IsNullOrWhiteSpace)
            || (contract.Permissions?.Length ?? 0) > 100)
            throw new SandboxException("sandbox_protocol_unsupported", "The app must declare hosty-sandbox-v1 and supported test roles.");
        if (selection.Manifest.CorePermissions.Count > 0)
            throw new SandboxException("sandbox_permissions_unsupported", "The offline recipe cannot require installed-app Core permissions.");
        if (selection.Manifest.Dependencies.Count > 0 || selection.Manifest.ExternalMounts.Values.Any(m => m.Required))
            throw new SandboxException("sandbox_dependencies_unsupported", "The offline recipe must supply isolated dependencies without external mounts.");
        if (selection.Services.Count == 0 || selection.Services.Count > (request.Limits ?? new()).Pids / 8)
            throw new SandboxException("sandbox_recipe_unsupported", "The service graph cannot fit the aggregate process budget.");
        var generated = contract.GeneratedSourceFiles?.GetValueOrDefault(request.Profile) ?? [];
        if (generated.Length > 16 || generated.Any(path => !DockerSourceRuntime.SafeRelative(path) || path == "."))
            throw new SandboxException("sandbox_recipe_unsupported", "Declare at most 16 contained generated source files.");
        if (pinned is not null && (pinned.Manifest.ManifestDigest != selection.ManifestDigest || pinned.Installation != target.InstalledAt))
            throw new SandboxException("sandbox_input_changed", "The reviewed execution recipe or app installation changed.");
        var images = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var service in selection.Services)
        {
            var runtime = service.Runtime;
            if ((runtime.Type ?? selection.RuntimeProfile.Type) != "docker" || runtime.IsHostNetwork
                || runtime.Capabilities.Count > 0 || runtime.Devices.Count > 0 || runtime.Build is not null
                || runtime.Image is null || (source is null && runtime.SourceMount is not null)
                || runtime.SourceMount is { Mode: not "ro" })
                throw new SandboxException("sandbox_recipe_unsupported", "Use an offline, non-privileged Docker recipe with a prepared image and read-only source.");
            if (runtime.SourceMount is { } mount)
                ValidateGeneratedSource(source!, mount.Path, generated);
            // Resolve the local image once; the digest is part of review and subsequent revalidation.
            var image = service.Image ?? throw new SandboxException("sandbox_recipe_unsupported", "The service image is unavailable.");
            var reference = pinned is null
                ? image.Repository + (image.Digest is { Length: > 0 } digest ? "@" + digest : ":" + image.Tag)
                : pinned.Images.GetValueOrDefault(service.Key)
                    ?? throw new SandboxException("sandbox_input_changed", "The pinned service graph changed.");
            var inspected = await docker.RunAsync(["image", "inspect", reference], null, ct);
            if (inspected.ExitCode != 0) throw new SandboxException("sandbox_image_unavailable", "Prepare the reviewed image before creating a sandbox.");
            using var imageDocument = JsonDocument.Parse(inspected.StandardOutput);
            var imageNode = imageDocument.RootElement[0];
            if (imageNode.GetProperty("Config").TryGetProperty("Volumes", out var volumes)
                && volumes.ValueKind == JsonValueKind.Object && volumes.EnumerateObject().Any())
                throw new SandboxException("sandbox_implicit_volume_unsupported", "The prepared image must not create anonymous writable volumes.");
            var imageId = imageNode.GetProperty("Id").GetString() ?? "";
            if (inspected.ExitCode != 0 || imageId.Length != 71 || !imageId.StartsWith("sha256:", StringComparison.Ordinal)
                || imageId[7..].Any(c => !char.IsAsciiHexDigit(c)))
                throw new SandboxException("sandbox_image_unavailable", "Prepare the reviewed image before creating a sandbox.");
            images.Add(service.Key, imageId);
        }
        var fingerprint = SandboxValidation.Hash(selection.ManifestDigest + "\n" +
            string.Join('\n', images.Select(pair => pair.Key + "=" + pair.Value)));
        if (request.Source!.ArtifactDigest is { } expected && expected != fingerprint)
            throw new SandboxException("sandbox_input_changed", "The pinned artifact inputs changed; review a new plan.");
        return new(target.Id, target.InstalledAt, fingerprint, selection, source,
            contract.Roles, contract.Permissions ?? [], images, selection.ManifestDigest == installed.ManifestDigest);
    }

    internal static void ValidateGeneratedSource(string source, string mountPath, IEnumerable<string> files)
    {
        var root = mountPath == "." ? source : ContainedSourcePath(source, mountPath);
        foreach (var file in files)
        {
            var full = ContainedSourcePath(root, file);
            if (!File.Exists(full))
                throw new SandboxException("sandbox_recipe_unsupported", "Generated source overlay files must already exist as regular files in the reviewed source.");
        }
    }

    private static string ContainedSourcePath(string root, string relativePath)
        => CoreDataPaths.TryResolveContainedRelativePath(root, relativePath, out var full)
            && !CoreDataPaths.ContainsSymbolicLink(root, full)
            ? full : throw new SandboxException("sandbox_path_invalid", "A sandbox source path escaped its authorized root.");

    public async Task AcquireAsync(SandboxInstance instance, CancellationToken ct)
    {
        if (instance.Request.Source.WorktreeId is { } id)
            await workspaces.SetSandboxConsumerAsync(id, instance.Id, true, ct);
    }
    public async Task ReleaseAsync(SandboxInstance instance, CancellationToken ct)
    {
        if (instance.Request.Source.WorktreeId is { } id)
            await workspaces.SetSandboxConsumerAsync(id, instance.Id, false, ct);
    }
}
