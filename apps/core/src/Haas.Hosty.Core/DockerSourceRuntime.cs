using System.Text.Json;
using System.Text.Json.Nodes;

namespace Haas.Hosty.Core;

internal sealed record RuntimeSourceMountManifest
{
    public string Path { get => field ?? "."; init; } = ".";
    public string Target { get => field ?? "/workspace"; init; } = "/workspace";
    public string Mode { get => field ?? "ro"; init; } = "ro";
    // Relative paths overlaid with Core-owned volumes, keeping Linux build outputs off the host.
    public IReadOnlyList<string> Caches { get => field ?? []; init; } = [];
}

internal sealed record RuntimeDockerBuildManifest
{
    public string Context { get => field ?? "."; init; } = ".";
    public string Dockerfile { get => field ?? "Dockerfile.dev"; init; } = "Dockerfile.dev";
    // Bump through manifest review to rebuild the environment; ordinary edits keep the locked image.
    public string Revision { get => field ?? "1"; init; } = "1";
}

internal static class DockerSourceRuntime
{
    internal static bool RequiresReview(RuntimeAppManifestSelection baseline, RuntimeAppManifestSelection candidate)
    {
        static JsonObject ProtectedContract(RuntimeAppManifestSelection selection)
        {
            var node = JsonNode.Parse(JsonSerializer.Serialize(selection.Manifest, CoreJsonSerializerContext.Default.RuntimeAppManifest))!.AsObject();
            foreach (var key in new[] { "name", "description", "version", "catalogMetadata", "ui" }) node.Remove(key);
            foreach (var service in node["services"]!.AsArray())
            {
                foreach (var runtime in service!["runtimes"]!.AsObject().Where(runtime => runtime.Key == selection.RuntimeProfile.Key))
                {
                    if (runtime.Value is not JsonObject recipe) continue;
                    if (recipe["type"]?.GetValue<string>() == "localCommand" || recipe["sourceMount"] is not null)
                    {
                        recipe.Remove("command");
                        recipe.Remove("setup");
                    }
                }
            }
            return node;
        }
        return !JsonNode.DeepEquals(ProtectedContract(baseline), ProtectedContract(candidate));
    }

    internal static string BuildFingerprint(RuntimeDockerBuildManifest build)
        => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(build, CoreJsonSerializerContext.Default.RuntimeDockerBuildManifest)))).ToLowerInvariant();

    internal sealed record Launch(IReadOnlyList<string> Arguments, IReadOnlyList<string> Command);

    internal static void Validate(string service, RuntimeProfileManifest profile, RuntimeServiceProfileManifest runtime,
        List<AppManifestValidationError> errors)
    {
        void Error(string message) => errors.Add(new("app_manifest_docker_source_invalid", $"Service '{service}': {message}", "$.services[].runtimes[].sourceMount"));
        if (runtime.Build is { } build)
        {
            if (runtime.SourceMount is null || runtime.Image is not null) Error("build requires sourceMount and replaces image.");
            if (!SafeRelative(build.Context) || !SafeRelative(build.Dockerfile) || string.IsNullOrWhiteSpace(build.Revision)) Error("Build paths must be contained in the checkout and revision must be non-empty.");
        }
        if (runtime.SourceMount is not { } mount)
        {
            if ((runtime.Type ?? profile.Type) == "docker" && runtime.Artifact == "source")
                errors.Add(new("app_runtime_artifact_unsupported", "Docker source execution requires sourceMount.", "$.services[].runtimes[].artifact"));
            return;
        }
        if ((runtime.Type ?? profile.Type) != "docker" || !profile.Development) Error("sourceMount requires a Docker service in a development profile.");
        if (runtime.Artifact is not null and not "source") Error("sourceMount requires artifact source.");
        if (!SafeRelative(mount.Path)) Error("Source path must stay inside the checkout.");
        if (!SafeTarget(mount.Target)) Error("Source target must be a non-root absolute container path.");
        if (mount.Mode is not ("ro" or "rw")) Error("Source access mode must be ro or rw.");
        if (string.IsNullOrWhiteSpace(runtime.Command)) Error("Source execution requires a command.");
        if (runtime.WorkingDirectory is { } cwd && !SafeRelative(cwd)) Error("Working directory must be relative to the source mount.");
        if (mount.Caches is null || mount.Caches.Any(path => !SafeRelative(path) || path == ".") || mount.Caches.Distinct(StringComparer.Ordinal).Count() != mount.Caches.Count)
            Error("Cache paths must be distinct relative directories inside the source mount.");
    }

    internal static bool SafeRelative(string path)
        => !string.IsNullOrWhiteSpace(path) && !System.IO.Path.IsPathRooted(path) &&
           !path.Contains('\\') && !path.Contains(':') && !path.Contains(',') &&
           (path == "." || !path.Split('/').Any(part => part is ".." or "." or "")) && !path.Any(char.IsControl);

    private static bool SafeTarget(string path)
        => path.StartsWith('/') && path.Length > 1 && SafeRelative(path[1..]) && path != "/var/run/docker.sock";

    private static string ContainedPath(string root, string relative)
    {
        if (relative == ".") return System.IO.Path.GetFullPath(root);
        if (CoreDataPaths.TryResolveContainedRelativePath(root, relative, out var path)) return path;
        throw new AppLifecycleException("docker_source_path_invalid", "Source and build paths must be contained relative paths.");
    }

    internal static string ResolveSourcePath(RuntimeLifecycleContext context, RuntimeSourceMountManifest mount)
    {
        var root = MountPathPolicy.ResolveRealPath(context.SourceRoot ?? context.App.SourceState?.LocalOverridePath ??
            context.App.SourceState?.ManagedCheckoutPath ?? context.AppRoot);
        var path = ContainedPath(root, mount.Path);
        if (!Directory.Exists(path) || CoreDataPaths.ContainsSymbolicLink(root, path))
            throw new AppLifecycleException("docker_source_path_invalid", "The source mount must be an existing directory within the authorized checkout, without symlink escapes.");
        // Bind syntax uses commas as separators. Refuse ambiguous host paths rather than widening a mount.
        if (path.Contains(',') || path.Any(char.IsControl))
            throw new AppLifecycleException("docker_source_path_invalid", "The source path cannot be represented safely as a Docker mount.");
        return path;
    }

    internal static async Task<(string Reference, ArtifactLock Lock)> ResolveBuildAsync(RuntimeLifecycleContext context,
        RuntimeSelectedService service, IDockerCommandRunner runner, ArtifactLock? existing, CancellationToken cancellationToken)
    {
        var build = service.Runtime.Build!;
        var fingerprint = BuildFingerprint(build);
        if (existing is { Kind: "development-image", ImageDigest: not null } && existing.BundleHash == fingerprint)
        {
            var check = await runner.RunAsync(["image", "inspect", existing.ImageDigest], null, cancellationToken);
            if (check.ExitCode != 0) throw new AppLifecycleException("docker_dev_image_missing", "The locked development image is missing. Review a new build revision to rebuild it.");
            return (existing.ImageDigest, existing);
        }
        if (existing is not null) throw new AppLifecycleException("docker_dev_build_requires_review", "Development environment changed; review and apply the source manifest to rebuild it.");
        var directory = ResolveSourcePath(context, new RuntimeSourceMountManifest { Path = build.Context });
        var dockerfile = ContainedPath(directory, build.Dockerfile);
        if (!File.Exists(dockerfile) || CoreDataPaths.ContainsSymbolicLink(directory, dockerfile))
            throw new AppLifecycleException("docker_dev_build_path_invalid", "The development Dockerfile must be a regular file inside the declared build context.");
        var owner = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(context.AppRoot)))[..12].ToLowerInvariant();
        var tag = DockerRuntimeAdapter.BuildContainerName(owner, context.App.Id, service.Key) + "-dev:" + fingerprint[..16];
        var result = await runner.RunAsync(["build", "--tag", tag, "--file", dockerfile, directory], null, cancellationToken);
        if (result.ExitCode != 0) throw new AppLifecycleException("docker_dev_build_failed", result.StandardError);
        var image = await runner.RunAsync(["image", "inspect", "--format", "{{.Id}}", tag], null, cancellationToken);
        var id = image.StandardOutput.Trim();
        if (image.ExitCode != 0 || !System.Text.RegularExpressions.Regex.IsMatch(id, "^sha256:[a-f0-9]{64}$"))
            throw new AppLifecycleException("docker_dev_image_unresolved", "Cannot resolve the built development image to an immutable image ID.");
        return (id, new ArtifactLock("development-image", id, tag, fingerprint, null, DateTimeOffset.UtcNow));
    }

    internal static async Task<(string Reference, ArtifactLock Lock)> ResolveLocalImageAsync(string reference,
        ArtifactLock? existing, IDockerCommandRunner runner, CancellationToken cancellationToken)
    {
        var image = await runner.RunAsync(["image", "inspect", "--format", "{{.Id}}", reference], null, cancellationToken);
        var id = image.StandardOutput.Trim();
        if (image.ExitCode != 0 || !System.Text.RegularExpressions.Regex.IsMatch(id, "^sha256:[a-f0-9]{64}$"))
            throw new AppLifecycleException("docker_dev_image_missing", "The local development environment image is unavailable. Review a new image or build revision.");
        return (id, existing ?? new ArtifactLock("development-image", id, reference, null, null, DateTimeOffset.UtcNow));
    }

    internal static async Task<Launch?> PrepareAsync(RuntimeLifecycleContext context, RuntimeSelectedService service,
        IDockerCommandRunner runner, CancellationToken cancellationToken)
    {
        if (service.Runtime.SourceMount is not { } mount) return null;
        var path = ResolveSourcePath(context, mount);
        // Docker resolves bind sources on its daemon host. A remote context cannot mount this checkout.
        var host = Environment.GetEnvironmentVariable("DOCKER_HOST");
        if (string.IsNullOrWhiteSpace(host) || !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("DOCKER_CONTEXT")))
        {
            var probe = await runner.RunAsync(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], null, cancellationToken);
            if (probe.ExitCode != 0) throw new AppLifecycleException("docker_source_context_unknown", "Cannot verify the Docker daemon location for source mounts.");
            host = probe.StandardOutput.Trim();
        }
        if (host is null || !(host.StartsWith("unix://", StringComparison.Ordinal) || host.StartsWith("npipe://", StringComparison.Ordinal)))
            throw new AppLifecycleException("docker_source_remote_unsupported", "Docker development requires a local Docker engine; remote engines cannot mount this source checkout.");
        var args = new List<string> { "--mount", $"type=bind,source={path},target={mount.Target}{(mount.Mode == "ro" ? ",readonly" : "")}",
            "--workdir", mount.Target.TrimEnd('/') + (string.IsNullOrWhiteSpace(service.Runtime.WorkingDirectory) ? "" : "/" + service.Runtime.WorkingDirectory) };
        for (var index = 0; index < mount.Caches.Count; index++)
        {
            args.Add("--mount");
            var name = DockerRuntimeAdapter.BuildContainerName("", context.App.Id, service.Key) + "-dev-" +
                Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(context.AppRoot + "|" + mount.Caches[index])))[..16].ToLowerInvariant();
            args.Add($"type=volume,source={name},target={mount.Target.TrimEnd('/')}/{mount.Caches[index]},volume-nocopy");
        }
        // This is CMD, not an entrypoint override: VPN/firewall initialization still executes first.
        var command = string.IsNullOrWhiteSpace(service.Runtime.Setup) ? service.Runtime.Command! : $"({service.Runtime.Setup}) && {service.Runtime.Command}";
        return new(args, ["/bin/sh", "-lc", command]);
    }
}
