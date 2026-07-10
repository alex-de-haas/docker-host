using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

internal sealed class AppManifestService(HttpClient? httpClient = null)
{
    private const string ManifestFileName = "manifest.json";
    private const string SupportedSchemaVersion = "app.0.1";
    private const int MaxManifestBytes = 1024 * 1024;
    private static readonly Regex ContractKeyPattern = new("^[a-z][a-z0-9-]{0,62}$", RegexOptions.Compiled);
    // External-mount keys allow camelCase (e.g. "catalogRoots") since they surface as
    // HOSTY_MOUNT_{KEY} env names and `/mnt/{key}/...` container paths, not lowercase contract keys.
    private static readonly Regex ExternalMountKeyPattern = new("^[A-Za-z][A-Za-z0-9_-]{0,62}$", RegexOptions.Compiled);
    private static readonly Regex AppIdPattern = new("^[a-z0-9][a-z0-9._-]{0,62}$", RegexOptions.Compiled);
    private readonly HttpClient httpClient = httpClient ?? new HttpClient { Timeout = TimeSpan.FromSeconds(20) };

    public async Task<RuntimeAppManifestSelection> LoadAsync(
        string manifestPath,
        string? selectedRuntime = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(manifestPath))
        {
            throw new AppManifestException("manifest_path_required", "A runtime app manifest path is required.");
        }

        var source = await ReadManifestSourceAsync(manifestPath.Trim(), cancellationToken);
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(source.Json))).ToLowerInvariant();
        RuntimeAppManifest? manifest;
        try
        {
            manifest = JsonSerializer.Deserialize(source.Json, CoreJsonSerializerContext.Default.RuntimeAppManifest);
        }
        catch (JsonException ex)
        {
            throw new AppManifestException("manifest_json_invalid", $"Runtime app manifest is not valid JSON: {ex.Message}");
        }

        if (manifest is null)
        {
            throw new AppManifestException("manifest_json_invalid", "Runtime app manifest must be a JSON object.");
        }

        return Select(manifest, source.Reference, digest, selectedRuntime, source.Json, source.ManifestUrl);
    }

    public async Task SaveManifestCopyAsync(
        RuntimeAppManifestSelection selection,
        string appRoot,
        CancellationToken cancellationToken = default)
    {
        Directory.CreateDirectory(appRoot);
        var targetPath = Path.Combine(appRoot, "manifest.json");
        if (string.Equals(selection.ManifestPath, targetPath, StringComparison.Ordinal))
        {
            return;
        }

        // Atomic temp+rename: a plain WriteAllText that crashes mid-write leaves a truncated manifest that
        // fails validation (manifest_json_invalid) on every later lifecycle verb with no self-heal.
        await JsonStorage.WriteTextAsync(targetPath, selection.ManifestJson, cancellationToken);
    }

    // Per-file caps for vendored display assets (D7). Mirrors the catalog tooling.
    private const long IconMaxBytes = 512 * 1024;
    private const long ScreenshotMaxBytes = 2 * 1024 * 1024;
    private const long DescriptionMaxBytes = 256 * 1024;
    private const long ImageMaxBytes = 2 * 1024 * 1024;
    private const int PerAppMaxAssetFiles = 32;
    private const long PerAppMaxAssetBytes = 20 * 1024 * 1024;
    private static readonly string[] ImageAssetExtensions = [".svg", ".png", ".webp", ".jpg", ".jpeg", ".gif", ".avif"];
    private static readonly Regex MarkdownInlineImage = new(@"!\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)", RegexOptions.Compiled);
    private static readonly Regex MarkdownHtmlImage = new("""<img\b[^>]*?\s+src\s*=\s*(?:"([^"]*)"|'([^']*)')""", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // Copy an installed app's manifest-declared display assets (icon, screenshots, markdown
    // descriptionFile and the images it references) next to the internal manifest copy under
    // <appRoot>, so the asset endpoint can serve them (manifest-level app assets). The source is the
    // manifest's own folder (local install) or the manifest URL's folder (URL install). Everything is
    // best-effort and display-only: any asset that is missing, too large, escapes the manifest folder,
    // or fails to fetch is simply skipped — this never throws and never blocks an install/update.
    public async Task VendorDisplayAssetsAsync(
        RuntimeAppManifestSelection selection,
        string appRoot,
        CancellationToken cancellationToken = default)
    {
        var meta = selection.Manifest.CatalogMetadata;
        var navIconAssets = (selection.Manifest.Ui?.Navigation ?? [])
            .Select(item => item.IconAsset)
            .Where(icon => !string.IsNullOrWhiteSpace(icon))
            .ToArray();
        if (meta is null && navIconAssets.Length == 0)
        {
            return;
        }

        Func<string, long, Task<byte[]?>>? read = null;
        if (!string.IsNullOrWhiteSpace(selection.ManifestUrl) &&
            Uri.TryCreate(selection.ManifestUrl, UriKind.Absolute, out var manifestUri) &&
            (manifestUri.Scheme == Uri.UriSchemeHttp || manifestUri.Scheme == Uri.UriSchemeHttps))
        {
            var root = new Uri(manifestUri, ".");
            read = (rootRel, cap) => ReadUrlAssetAsync(root, rootRel, cap, cancellationToken);
        }
        else
        {
            var baseDir = Path.GetDirectoryName(Path.GetFullPath(selection.ManifestPath));
            if (!string.IsNullOrEmpty(baseDir))
            {
                read = (rootRel, cap) => ReadLocalAssetAsync(baseDir, rootRel, cap, cancellationToken);
            }
        }

        if (read is null)
        {
            return;
        }

        var budget = new AssetBudget();

        async Task VendorAsync(string? relativeRef, string dirRootRel, long cap, bool imageOnly)
        {
            var rootRel = CoreDataPaths.NormalizeRelativeAssetPath(dirRootRel, relativeRef);
            if (rootRel is null || (imageOnly && !ImageAssetExtensions.Contains(Path.GetExtension(rootRel), StringComparer.OrdinalIgnoreCase)))
            {
                return;
            }

            var bytes = await read(rootRel, cap);
            if (bytes is null || !budget.TryAdd(bytes.Length))
            {
                return;
            }

            WriteVendoredAsset(appRoot, rootRel, bytes);
        }

        if (meta is not null)
        {
            // A relative icon (an absolute https icon is served as-is, not vendored) and screenshots.
            if (!IsAbsoluteHttpAsset(meta.Icon))
            {
                await VendorAsync(meta.Icon, "", IconMaxBytes, imageOnly: true);
            }

            foreach (var screenshot in meta.Screenshots)
            {
                if (!IsAbsoluteHttpAsset(screenshot))
                {
                    await VendorAsync(screenshot, "", ScreenshotMaxBytes, imageOnly: true);
                }
            }

            // The markdown description, then the relative images it references (resolved against the
            // description's own folder but contained under the manifest folder — a doc in docs/ may
            // reference ../assets/icon.svg).
            var descriptionRootRel = CoreDataPaths.NormalizeRelativeAssetPath("", meta.DescriptionFile);
            if (descriptionRootRel is not null && string.Equals(Path.GetExtension(descriptionRootRel), ".md", StringComparison.OrdinalIgnoreCase))
            {
                var markdown = await read(descriptionRootRel, DescriptionMaxBytes);
                if (markdown is not null && budget.TryAdd(markdown.Length))
                {
                    WriteVendoredAsset(appRoot, descriptionRootRel, markdown);

                    var descriptionDir = descriptionRootRel.Contains('/') ? descriptionRootRel[..descriptionRootRel.LastIndexOf('/')] : "";
                    foreach (var imageRef in DiscoverMarkdownImageRefs(Encoding.UTF8.GetString(markdown)))
                    {
                        await VendorAsync(imageRef, descriptionDir, ImageMaxBytes, imageOnly: true);
                    }
                }
            }
        }

        // Per-page sidebar icons (ui.navigation[].iconAsset), served through the same asset endpoint.
        foreach (var navIcon in navIconAssets)
        {
            await VendorAsync(navIcon, "", ImageMaxBytes, imageOnly: true);
        }
    }

    private static bool IsAbsoluteHttpAsset(string? value)
        => !string.IsNullOrWhiteSpace(value) &&
            Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
            (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

    private static IEnumerable<string> DiscoverMarkdownImageRefs(string markdown)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (Match match in MarkdownInlineImage.Matches(markdown))
        {
            var value = match.Groups[1].Value.Trim().Trim('<', '>').Trim();
            if (value.Length > 0 && seen.Add(value))
            {
                yield return value;
            }
        }

        foreach (Match match in MarkdownHtmlImage.Matches(markdown))
        {
            var value = (match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value).Trim();
            if (value.Length > 0 && seen.Add(value))
            {
                yield return value;
            }
        }
    }

    private async Task<byte[]?> ReadLocalAssetAsync(string baseDir, string rootRel, long cap, CancellationToken cancellationToken)
    {
        if (!CoreDataPaths.TryResolveContainedRelativePath(baseDir, rootRel, out var fullPath) || !File.Exists(fullPath))
        {
            return null;
        }

        var info = new FileInfo(fullPath);
        if (info.Length > cap)
        {
            return null;
        }

        try
        {
            return await File.ReadAllBytesAsync(fullPath, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // Display-only best-effort: only genuine caller cancellation propagates; any IO/access error
            // leaves the asset absent (endpoint 404s) rather than failing the install.
            return null;
        }
    }

    private async Task<byte[]?> ReadUrlAssetAsync(Uri root, string rootRel, long cap, CancellationToken cancellationToken)
    {
        Uri assetUri;
        try
        {
            assetUri = new Uri(root, rootRel);
        }
        catch (UriFormatException)
        {
            return null;
        }

        if (!assetUri.AbsoluteUri.StartsWith(root.AbsoluteUri, StringComparison.Ordinal))
        {
            return null;
        }

        try
        {
            using var response = await httpClient.GetAsync(assetUri, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (!response.IsSuccessStatusCode || response.Content.Headers.ContentLength is > 0 and var declared && declared > cap)
            {
                return null;
            }

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var buffer = new MemoryStream();
            var chunk = new byte[81920];
            long total = 0;
            while (true)
            {
                var count = await stream.ReadAsync(chunk, cancellationToken);
                if (count == 0)
                {
                    break;
                }

                total += count;
                if (total > cap)
                {
                    return null;
                }

                buffer.Write(chunk, 0, count);
            }

            return buffer.ToArray();
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // Best-effort: an HTTP error, socket drop, disposed stream, or fetch timeout leaves the asset
            // absent instead of failing the install; only genuine caller cancellation propagates.
            return null;
        }
    }

    private static void WriteVendoredAsset(string appRoot, string rootRel, byte[] bytes)
    {
        if (!CoreDataPaths.TryResolveContainedRelativePath(appRoot, rootRel, out var dest))
        {
            return;
        }

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            File.WriteAllBytes(dest, bytes);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Display-only: a failed write leaves the asset absent and the endpoint 404s.
        }
    }

    private sealed class AssetBudget
    {
        private int files;
        private long bytes;

        public bool TryAdd(long size)
        {
            if (files + 1 > PerAppMaxAssetFiles || bytes + size > PerAppMaxAssetBytes)
            {
                return false;
            }

            files++;
            bytes += size;
            return true;
        }
    }

    public RuntimeAppManifestSelection Select(
        RuntimeAppManifest manifest,
        string manifestPath,
        string manifestDigest,
        string? selectedRuntime = null,
        string? manifestJson = null,
        string? manifestUrl = null)
    {
        var errors = new List<AppManifestValidationError>();
        ValidateRequired(manifest.SchemaVersion, "$.schemaVersion", errors);
        ValidateRequired(manifest.Id, "$.id", errors);
        ValidateRequired(manifest.Name, "$.name", errors);
        ValidateRequired(manifest.Version, "$.version", errors);

        if (!string.Equals(manifest.SchemaVersion, SupportedSchemaVersion, StringComparison.Ordinal))
        {
            errors.Add(new("unsupported_app_manifest_schema_version", "Only app.0.1 runtime app manifests are supported by Hosty Core.", "$.schemaVersion"));
        }

        if (manifest.Role is not null && !string.Equals(manifest.Role, "system", StringComparison.Ordinal))
        {
            errors.Add(new("app_manifest_role_unsupported", "role must be omitted or the string 'system'.", "$.role"));
        }

        // System-app UI is validated strictly and fail-closed (docs/ideas/system-app-pages.md):
        // its pages are rendered as administrator Shell surfaces, so a system app must not rely on
        // the permissive runtime fallbacks (endpoint guessing, path prefixing) ordinary app.0.1
        // manifests keep for compatibility. Headless system apps (no ui block) are unaffected.
        if (string.Equals(manifest.Role, "system", StringComparison.Ordinal) && manifest.Ui is { } systemUi)
        {
            ValidateSystemUi(manifest, systemUi, errors);
        }

        if (!string.IsNullOrWhiteSpace(manifest.Id) && !IsSafeIdentifier(manifest.Id))
        {
            errors.Add(new("app_manifest_id_invalid", "App id must match ^[a-z0-9][a-z0-9._-]{0,62}$ and must not be a path segment such as '.' or '..'.", "$.id"));
        }

        if (manifest.RuntimeProfiles.Count == 0)
        {
            errors.Add(new("app_manifest_runtime_profile_required", "runtimeProfiles must be a non-empty array.", "$.runtimeProfiles"));
        }

        var profileKeys = new HashSet<string>(StringComparer.Ordinal);
        var defaultProfileCount = 0;
        foreach (var profile in manifest.RuntimeProfiles)
        {
            if (string.IsNullOrWhiteSpace(profile.Key))
            {
                errors.Add(new("app_manifest_runtime_profile_key_required", "runtimeProfiles[].key is required.", "$.runtimeProfiles[].key"));
                continue;
            }

            if (!ContractKeyPattern.IsMatch(profile.Key))
            {
                errors.Add(new("app_manifest_runtime_profile_key_invalid", "runtimeProfiles[].key must match ^[a-z][a-z0-9-]{0,62}$.", "$.runtimeProfiles[].key"));
            }

            if (!profileKeys.Add(profile.Key))
            {
                errors.Add(new("app_manifest_runtime_profile_duplicate", $"Runtime profile '{profile.Key}' is declared more than once.", "$.runtimeProfiles[].key"));
            }

            if (profile.Type is not "docker" and not "localCommand")
            {
                errors.Add(new("app_manifest_runtime_type_unsupported", $"Runtime profile type '{profile.Type}' is not supported by this Hosty Core build.", "$.runtimeProfiles[].type"));
            }

            // `development` gates source override + the live update model, both of which only make
            // sense for a source runtime (localCommand in v1). A docker profile cannot be a
            // development runtime.
            if (profile.Development && profile.Type is not "localCommand")
            {
                errors.Add(new("app_manifest_development_requires_local_command", $"Runtime profile '{profile.Key}' sets development: true, which is only supported for a localCommand runtime.", "$.runtimeProfiles[].development"));
            }

            if (profile.Default)
            {
                defaultProfileCount++;
            }
        }

        if (defaultProfileCount > 1)
        {
            errors.Add(new("app_manifest_runtime_default_duplicate", "Only one runtime profile may set default: true.", "$.runtimeProfiles"));
        }

        // `development` is now only the *default* for a per-runtime operator Development Mode toggle, so
        // several flagged runtimes are harmless (each just defaults to live) — the former "at most one
        // development runtime" rule is retired. See runtime-artifact-model.md.

        var resolvedRuntime = selectedRuntime?.Trim();
        if (string.IsNullOrWhiteSpace(resolvedRuntime))
        {
            resolvedRuntime = string.IsNullOrWhiteSpace(manifest.DefaultRuntime)
                ? manifest.RuntimeProfiles.FirstOrDefault(profile => profile.Default)?.Key ?? manifest.RuntimeProfiles.FirstOrDefault()?.Key
                : manifest.DefaultRuntime;
        }

        var selectedProfile = manifest.RuntimeProfiles.FirstOrDefault(profile =>
            string.Equals(profile.Key, resolvedRuntime, StringComparison.Ordinal));
        if (selectedProfile is null)
        {
            errors.Add(new("app_manifest_selected_runtime_missing", $"Selected runtime '{resolvedRuntime}' does not reference a runtime profile.", "$.defaultRuntime"));
        }

        if (manifest.Services.Count == 0)
        {
            errors.Add(new("app_manifest_services_required", "services must be a non-empty array.", "$.services"));
        }

        var selectedServices = new List<RuntimeSelectedService>();
        var serviceKeys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var service in manifest.Services)
        {
            if (string.IsNullOrWhiteSpace(service.Key))
            {
                errors.Add(new("app_manifest_service_key_required", "services[].key is required.", "$.services[].key"));
                continue;
            }

            if (!ContractKeyPattern.IsMatch(service.Key))
            {
                errors.Add(new("app_manifest_service_key_invalid", "services[].key must match ^[a-z][a-z0-9-]{0,62}$.", "$.services[].key"));
            }

            if (!serviceKeys.Add(service.Key))
            {
                errors.Add(new("app_manifest_service_duplicate", $"Service '{service.Key}' is declared more than once.", "$.services[].key"));
            }

            foreach (var runtimeKey in service.Runtimes.Keys)
            {
                if (!profileKeys.Contains(runtimeKey))
                {
                    errors.Add(new("app_manifest_service_runtime_unknown", $"Service '{service.Key}' declares unknown runtime profile '{runtimeKey}'.", "$.services[].runtimes"));
                }
            }

            if (selectedProfile is null)
            {
                continue;
            }

            if (!service.Runtimes.TryGetValue(selectedProfile.Key, out var runtime))
            {
                errors.Add(new("app_manifest_service_runtime_missing", $"Service '{service.Key}' must declare selected runtime '{selectedProfile.Key}'.", "$.services[].runtimes"));
                continue;
            }

            var runtimeType = string.IsNullOrWhiteSpace(runtime.Type) ? selectedProfile.Type : runtime.Type;
            if (!string.Equals(runtimeType, selectedProfile.Type, StringComparison.Ordinal))
            {
                errors.Add(new("app_manifest_service_runtime_type_mismatch", $"Service '{service.Key}' runtime type '{runtimeType}' must match profile type '{selectedProfile.Type}'.", "$.services[].runtimes[].type"));
                continue;
            }

            RuntimeDockerImage? image = null;
            if (runtimeType == "docker")
            {
                image = ParseDockerImage(runtime.Image, errors, "$.services[].runtimes[].image");
                if (image is null)
                {
                    continue;
                }
            }
            else if (string.IsNullOrWhiteSpace(runtime.Command))
            {
                errors.Add(new("app_manifest_runtime_command_required", "localCommand runtime profiles must declare command.", "$.services[].runtimes[].command"));
                continue;
            }

            ValidateSetup(service.Key, runtimeType, runtime.Setup, errors);
            ValidateNetwork(service.Key, runtimeType, runtime.Network, errors);
            ValidateCapabilities(service.Key, runtimeType, runtime.Capabilities, errors);
            ValidateDevices(service.Key, runtimeType, runtime.Devices, errors);
            ValidatePorts(service.Key, runtime.Ports, runtime.IsHostNetwork, errors);
            ValidateHealthcheck(service.Key, runtimeType, runtime.Ports, runtime.Healthcheck, errors);

            var artifact = ResolveArtifactKind(service.Key, runtimeType, runtime.Artifact, errors);
            ValidateDelivery(service.Key, artifact, runtime.Delivery, errors);
            if (artifact is null)
            {
                continue;
            }

            selectedServices.Add(new RuntimeSelectedService(service.Key, service.DependsOn, runtime with { Type = runtimeType }, image, artifact));
        }

        if (selectedProfile is not null && selectedServices.Count == 0)
        {
            errors.Add(new("app_manifest_selected_services_missing", "The selected runtime does not produce any runnable services.", "$.services"));
        }

        // dependsOn drives both startup ordering and intra-app URL discovery (HOSTY_SERVICE_{KEY}_URL),
        // so each entry must name a real sibling service (not itself), and a named port must exist on
        // that sibling under the selected runtime.
        foreach (var service in manifest.Services)
        {
            foreach (var dependency in service.DependsOn)
            {
                if (string.IsNullOrWhiteSpace(dependency.Service))
                {
                    errors.Add(new("app_manifest_service_depends_on_required", "services[].dependsOn entries must name a service.", "$.services[].dependsOn"));
                    continue;
                }

                if (string.Equals(dependency.Service, service.Key, StringComparison.Ordinal))
                {
                    errors.Add(new("app_manifest_service_depends_on_self", $"Service '{service.Key}' cannot depend on itself.", "$.services[].dependsOn"));
                    continue;
                }

                if (!serviceKeys.Contains(dependency.Service))
                {
                    errors.Add(new("app_manifest_service_depends_on_unknown", $"Service '{service.Key}' depends on unknown service '{dependency.Service}'.", "$.services[].dependsOn"));
                    continue;
                }

                if (selectedProfile is not null && !string.IsNullOrWhiteSpace(dependency.Port))
                {
                    var target = manifest.Services.FirstOrDefault(candidate => string.Equals(candidate.Key, dependency.Service, StringComparison.Ordinal));
                    var hasPort = target is not null &&
                        target.Runtimes.TryGetValue(selectedProfile.Key, out var targetRuntime) &&
                        targetRuntime.Ports.Any(port => RuntimeServiceDiscovery.PortMatches(port, dependency.Port));
                    if (!hasPort)
                    {
                        errors.Add(new("app_manifest_service_depends_on_port_unknown", $"Service '{service.Key}' depends on port '{dependency.Port}' of '{dependency.Service}', which does not declare it under runtime '{selectedProfile.Key}'.", "$.services[].dependsOn"));
                    }
                }
            }
        }

        var normalizedMountKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (mountKey, mount) in manifest.ExternalMounts)
        {
            if (!ExternalMountKeyPattern.IsMatch(mountKey))
            {
                errors.Add(new("app_manifest_external_mount_key_invalid", "externalMounts keys must match ^[A-Za-z][A-Za-z0-9_-]{0,62}$.", "$.externalMounts"));
            }
            else if (!normalizedMountKeys.Add(RuntimePortHelper.NormalizeEnvironmentKey(mountKey)))
            {
                // Two keys that normalize to the same HOSTY_MOUNT_{KEY} env name would silently
                // overwrite each other when injected, so reject the collision up front.
                errors.Add(new("app_manifest_external_mount_key_collision", $"externalMounts key '{mountKey}' normalizes to the same HOSTY_MOUNT_ environment name as another slot.", "$.externalMounts"));
            }

            if (!string.Equals(mount.Kind, "host-path", StringComparison.Ordinal))
            {
                errors.Add(new("app_manifest_external_mount_kind_unsupported", $"externalMounts['{mountKey}'].kind '{mount.Kind}' is not supported; only 'host-path' is allowed.", "$.externalMounts"));
            }

            if (mount.Mode is not "ro" and not "rw")
            {
                errors.Add(new("app_manifest_external_mount_mode_invalid", $"externalMounts['{mountKey}'].mode must be 'ro' or 'rw'.", "$.externalMounts"));
            }

            if (!string.IsNullOrWhiteSpace(mount.Service) && !serviceKeys.Contains(mount.Service))
            {
                errors.Add(new("app_manifest_external_mount_service_unknown", $"externalMounts['{mountKey}'].service references unknown service '{mount.Service}'.", "$.externalMounts"));
            }
        }

        if (manifest.RestartPolicy is { } restartPolicy)
        {
            // Normalize the same way RuntimeRestartPolicy.FromManifest does, so the manifest API is not
            // stricter than the runtime that consumes it ("ON-FAILURE" / " always " resolve fine).
            if ((restartPolicy.Mode ?? "no").Trim().ToLowerInvariant() is not ("no" or "on-failure" or "always"))
            {
                errors.Add(new("app_manifest_restart_policy_mode_invalid", "restartPolicy.mode must be 'no', 'on-failure', or 'always'.", "$.restartPolicy.mode"));
            }

            if (restartPolicy.MaxRetries is < 0)
            {
                errors.Add(new("app_manifest_restart_policy_max_retries_invalid", "restartPolicy.maxRetries must be zero or greater.", "$.restartPolicy.maxRetries"));
            }

            if (restartPolicy.BackoffSeconds is < 0)
            {
                errors.Add(new("app_manifest_restart_policy_backoff_invalid", "restartPolicy.backoffSeconds must be zero or greater.", "$.restartPolicy.backoffSeconds"));
            }
        }

        if (manifest.Telemetry is { SampleRatio: { } sampleRatio } && (sampleRatio < 0.0 || sampleRatio > 1.0))
        {
            errors.Add(new("app_manifest_telemetry_sample_ratio_invalid", "telemetry.sampleRatio must be between 0 and 1.", "$.telemetry.sampleRatio"));
        }

        ValidateDependencies(manifest.Dependencies, errors);

        RuntimeAppDataTarget? dataTarget = null;
        if (manifest.Data?.Enabled == true && selectedProfile is not null)
        {
            dataTarget = manifest.Data.Targets.FirstOrDefault(target =>
                string.Equals(target.Runtime, selectedProfile.Key, StringComparison.Ordinal) ||
                string.Equals(target.Runtime, selectedProfile.Type, StringComparison.Ordinal));

            if (selectedProfile.Type == "docker" && dataTarget is null)
            {
                dataTarget = new RuntimeAppDataTarget
                {
                    Runtime = selectedProfile.Key,
                    Service = selectedServices.FirstOrDefault()?.Key,
                    ContainerPath = "/app/data",
                    Environment = "HOSTY_APP_DATA_DIR",
                };
            }
        }

        if (errors.Count > 0)
        {
            throw new AppManifestException("manifest_validation_failed", "Runtime app manifest failed validation.", errors);
        }

        return new RuntimeAppManifestSelection(
            Manifest: manifest,
            ManifestPath: manifestPath,
            ManifestDigest: manifestDigest,
            RuntimeProfile: selectedProfile!,
            Services: selectedServices,
            DataTarget: dataTarget,
            ManifestJson: manifestJson ?? JsonSerializer.Serialize(manifest, CoreJsonSerializerContext.Default.RuntimeAppManifest),
            ManifestUrl: manifestUrl);
    }

    private async Task<AppManifestSource> ReadManifestSourceAsync(string manifestPath, CancellationToken cancellationToken)
    {
        if (TryCreateAbsoluteUri(manifestPath, out var uri))
        {
            if (IsHttpManifestUri(uri))
            {
                return await DownloadManifestAsync(uri, cancellationToken);
            }

            if (uri.IsFile)
            {
                return await ReadLocalManifestAsync(uri.LocalPath, cancellationToken);
            }

            throw new AppManifestException("manifest_url_scheme_unsupported", "Runtime app manifest URL must use http or https.");
        }

        return await ReadLocalManifestAsync(manifestPath, cancellationToken);
    }

    private static async Task<AppManifestSource> ReadLocalManifestAsync(string manifestPath, CancellationToken cancellationToken)
    {
        var fullPath = Path.GetFullPath(manifestPath);
        var isDirectory = Directory.Exists(fullPath);
        var resolvedPath = isDirectory
            ? Path.Combine(fullPath, ManifestFileName)
            : fullPath;

        if (!File.Exists(resolvedPath))
        {
            if (isDirectory)
            {
                throw new AppManifestException(
                    "manifest_not_found",
                    $"Runtime app manifest directory '{fullPath}' does not contain a {ManifestFileName} file.");
            }

            throw new AppManifestException("manifest_not_found", $"Runtime app manifest was not found at '{fullPath}'.");
        }

        return new AppManifestSource(resolvedPath, await File.ReadAllTextAsync(resolvedPath, cancellationToken), ManifestUrl: null);
    }

    private async Task<AppManifestSource> DownloadManifestAsync(Uri uri, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.Accept.ParseAdd("application/json");
        using var response = await SendManifestRequestAsync(request, uri, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new AppManifestException(
                "manifest_fetch_failed",
                $"Runtime app manifest URL returned HTTP {(int)response.StatusCode}.");
        }

        if (response.Content.Headers.ContentLength is > MaxManifestBytes)
        {
            throw new AppManifestException(
                "manifest_too_large",
                $"Runtime app manifest response exceeds the {MaxManifestBytes} byte limit.");
        }

        return new AppManifestSource(uri.AbsoluteUri, await ReadManifestResponseAsync(response.Content, cancellationToken), uri.AbsoluteUri);
    }

    private async Task<HttpResponseMessage> SendManifestRequestAsync(HttpRequestMessage request, Uri uri, CancellationToken cancellationToken)
    {
        try
        {
            return await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new AppManifestException("manifest_fetch_failed", $"Runtime app manifest URL '{uri.AbsoluteUri}' timed out.");
        }
        catch (HttpRequestException ex)
        {
            throw new AppManifestException("manifest_fetch_failed", $"Runtime app manifest URL could not be fetched: {ex.Message}");
        }
    }

    private static async Task<string> ReadManifestResponseAsync(HttpContent content, CancellationToken cancellationToken)
    {
        await using var source = await content.ReadAsStreamAsync(cancellationToken);
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        var total = 0;
        while (true)
        {
            var read = await source.ReadAsync(chunk, cancellationToken);
            if (read == 0)
            {
                break;
            }

            total += read;
            if (total > MaxManifestBytes)
            {
                throw new AppManifestException(
                    "manifest_too_large",
                    $"Runtime app manifest response exceeds the {MaxManifestBytes} byte limit.");
            }

            buffer.Write(chunk, 0, read);
        }

        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    private static bool TryCreateAbsoluteUri(string value, out Uri uri)
    {
        if (Uri.TryCreate(value, UriKind.Absolute, out var parsed) &&
            !string.IsNullOrWhiteSpace(parsed.Scheme) &&
            !parsed.IsUnc)
        {
            uri = parsed;
            return true;
        }

        uri = null!;
        return false;
    }

    private static bool IsHttpManifestUri(Uri uri)
        => string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase);

    private sealed record AppManifestSource(string Reference, string Json, string? ManifestUrl);

    private static RuntimeDockerImage? ParseDockerImage(JsonElement? value, List<AppManifestValidationError> errors, string path)
    {
        if (value is null || value.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            errors.Add(new("app_manifest_runtime_image_required", "Docker runtime profiles must declare an image string or object.", path));
            return null;
        }

        if (value.Value.ValueKind == JsonValueKind.String)
        {
            var reference = value.Value.GetString()?.Trim();
            if (string.IsNullOrWhiteSpace(reference))
            {
                errors.Add(new("app_manifest_runtime_image_required", "Docker runtime image cannot be blank.", path));
                return null;
            }

            var split = SplitImageReference(reference);
            return new RuntimeDockerImage(split.Repository, split.Tag);
        }

        if (value.Value.ValueKind != JsonValueKind.Object)
        {
            errors.Add(new("app_manifest_runtime_image_required", "Docker runtime image must be a string or object.", path));
            return null;
        }

        var repository = ReadString(value.Value, "repository");
        var tag = ReadString(value.Value, "tag");
        if (string.IsNullOrWhiteSpace(repository) || string.IsNullOrWhiteSpace(tag))
        {
            errors.Add(new("app_manifest_runtime_image_required", "Docker runtime image object must declare repository and tag.", path));
            return null;
        }

        // pullPolicy is intentionally not read: pull behaviour now derives from the app-level
        // pinned/rolling policy (see runtime-app-marketplace.md, A8). A digest is never authored
        // into the manifest — it is resolved at install/update and stored in the lock.
        return new RuntimeDockerImage(repository, tag);
    }

    private static (string Repository, string Tag) SplitImageReference(string reference)
    {
        var lastSlash = reference.LastIndexOf('/');
        var lastColon = reference.LastIndexOf(':');
        if (lastColon > lastSlash)
        {
            return (reference[..lastColon], reference[(lastColon + 1)..]);
        }

        return (reference, "latest");
    }

    private static string? ReadString(JsonElement element, string propertyName)
        => element.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static bool IsSafeIdentifier(string value)
        => AppIdPattern.IsMatch(value) &&
            value is not "." and not ".." &&
            CoreDataPaths.IsSafePathSegment(value);

    // Resolve the per-service artifact kind (A1). Absent infers per runtime type (docker → image,
    // localCommand → source). v1 supports exactly one kind per runtime: docker = image,
    // localCommand = source; `prebuilt` is reserved and any other value is rejected. Returns the
    // resolved kind, or null after recording an error (the caller skips the service). See
    // runtime-app-marketplace.md, R1–R4.
    private static string? ResolveArtifactKind(string serviceKey, string runtimeType, string? declared, List<AppManifestValidationError> errors)
    {
        var isDocker = string.Equals(runtimeType, "docker", StringComparison.Ordinal);

        // R1: an absent artifact infers per runtime type (docker → image, localCommand → source)
        // silently for back-compat — no error and no advisory (deferred to R15/R16).
        if (string.IsNullOrWhiteSpace(declared))
        {
            return isDocker ? "image" : "source";
        }

        var artifact = declared.Trim();
        if (artifact is not ("image" or "source" or "prebuilt"))
        {
            errors.Add(new("app_runtime_artifact_unsupported", $"Service '{serviceKey}' declares unsupported artifact '{artifact}'; expected 'image', 'source', or 'prebuilt'.", "$.services[].runtimes[].artifact"));
            return null;
        }

        // docker delivers an image; localCommand delivers source (live) or prebuilt (compiled build).
        var supported = isDocker ? artifact is "image" : artifact is "source" or "prebuilt";
        if (!supported)
        {
            var allowed = isDocker ? "'image'" : "'source' or 'prebuilt'";
            errors.Add(new("app_runtime_artifact_unsupported", $"Service '{serviceKey}' runtime '{runtimeType}' supports artifact {allowed}, not '{artifact}'.", "$.services[].runtimes[].artifact"));
            return null;
        }

        return artifact;
    }

    // Validates the `delivery` descriptor against the resolved artifact kind: required (folder, with a
    // path) for `prebuilt`, rejected for every other kind. Skips when the kind was unresolved (the
    // artifact error already stands). See runtime-artifact-model.md.
    private static void ValidateDelivery(string serviceKey, string? artifactKind, RuntimePrebuiltDeliveryManifest? delivery, List<AppManifestValidationError> errors)
    {
        const string path = "$.services[].runtimes[].delivery";
        if (artifactKind is null)
        {
            return;
        }

        if (!string.Equals(artifactKind, "prebuilt", StringComparison.Ordinal))
        {
            if (delivery is not null)
            {
                errors.Add(new("app_manifest_delivery_requires_prebuilt", $"Service '{serviceKey}' declares delivery, which is only supported for artifact 'prebuilt'.", path));
            }

            return;
        }

        if (delivery is null)
        {
            errors.Add(new("app_manifest_prebuilt_delivery_required", $"Service '{serviceKey}' artifact 'prebuilt' requires a delivery descriptor.", path));
            return;
        }

        if (!string.Equals(delivery.Type, "folder", StringComparison.Ordinal))
        {
            errors.Add(new("app_manifest_prebuilt_delivery_type_unsupported", $"Service '{serviceKey}' delivery.type '{delivery.Type}' is not supported; expected 'folder'.", path));
        }

        if (string.IsNullOrWhiteSpace(delivery.Path))
        {
            errors.Add(new("app_manifest_prebuilt_delivery_path_required", $"Service '{serviceKey}' delivery.path is required for a folder delivery.", path));
        }
    }

    private static void ValidateRequired(string? value, string path, List<AppManifestValidationError> errors)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            errors.Add(new("app_manifest_required_field_missing", $"{path} is required.", path));
        }
    }

    // Strict, fail-closed UI validation for role: system manifests. Ordinary manifests keep the
    // permissive runtime behavior (endpoint fallback, path prefixing); a system app's pages are
    // administrator Shell surfaces, so every reference must be explicit and resolvable.
    private static void ValidateSystemUi(RuntimeAppManifest manifest, RuntimeAppUiManifest ui, List<AppManifestValidationError> errors)
    {
        var (entryEndpointKey, entryPath) = AppUiContract.ReadDeclaredEntrypoint(ui);
        if (entryEndpointKey is null)
        {
            errors.Add(new(
                "app_manifest_system_ui_endpoint_required",
                "A system app UI must declare an explicit entrypoint endpoint; the runtime fallback to another endpoint is not allowed for system apps.",
                "$.ui.entrypoint.endpoint"));
        }
        else
        {
            ValidateSystemUiEndpointReference(manifest, entryEndpointKey, "$.ui.entrypoint.endpoint", errors);
        }

        if (entryPath is not null)
        {
            ValidateSystemUiPath(entryPath, "$.ui.entrypoint.path", errors);
        }

        var seenPaths = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in ui.Navigation)
        {
            if (!string.IsNullOrWhiteSpace(item.Path))
            {
                ValidateSystemUiPath(item.Path.Trim(), "$.ui.navigation[].path", errors);
            }

            var itemEndpointKey = item.Endpoint ?? item.PortKey;
            if (!string.IsNullOrWhiteSpace(itemEndpointKey))
            {
                ValidateSystemUiEndpointReference(manifest, itemEndpointKey.Trim(), "$.ui.navigation[].endpoint", errors);
            }

            // Blank paths fall back to the entrypoint path at runtime, so they participate in
            // duplicate detection under that effective value.
            var effectivePath = string.IsNullOrWhiteSpace(item.Path) ? (entryPath ?? "/") : item.Path.Trim();
            if (!seenPaths.Add(effectivePath))
            {
                errors.Add(new(
                    "app_manifest_system_ui_path_duplicate",
                    $"System app UI declares page path '{effectivePath}' more than once.",
                    "$.ui.navigation[].path"));
            }
        }
    }

    private static void ValidateSystemUiEndpointReference(RuntimeAppManifest manifest, string endpointKey, string path, List<AppManifestValidationError> errors)
    {
        var declared = manifest.Endpoints.FirstOrDefault(endpoint => string.Equals(endpoint.Key, endpointKey, StringComparison.Ordinal));
        if (declared is null)
        {
            errors.Add(new(
                "app_manifest_system_ui_endpoint_unknown",
                $"System app UI references endpoint '{endpointKey}', which is not a declared endpoint.",
                path));
            return;
        }

        if (declared.Protocol is not (null or "http" or "https"))
        {
            errors.Add(new(
                "app_manifest_system_ui_endpoint_not_http",
                $"System app UI endpoint '{endpointKey}' must use http or https, not '{declared.Protocol}'.",
                path));
        }
    }

    private static void ValidateSystemUiPath(string value, string path, List<AppManifestValidationError> errors)
    {
        var valid = value.StartsWith("/", StringComparison.Ordinal) &&
            !value.StartsWith("//", StringComparison.Ordinal) &&
            !value.Contains("://", StringComparison.Ordinal) &&
            !value.Contains('?', StringComparison.Ordinal) &&
            !value.Contains('#', StringComparison.Ordinal);
        if (!valid)
        {
            errors.Add(new(
                "app_manifest_system_ui_path_invalid",
                $"System app UI page path '{value}' must be root-relative and contain no scheme, host, query, or fragment.",
                path));
        }
    }

    // Validates a service's docker network mode. `network` is meaningful only under the docker
    // runtime; "host" anywhere else is rejected so the mistake surfaces at install time. null is
    // the default (bridge) and needs no declaration.
    private static void ValidateNetwork(string serviceKey, string runtimeType, string? network, List<AppManifestValidationError> errors)
    {
        const string path = "$.services[].runtimes[].network";
        if (network is null)
        {
            return;
        }

        if (!string.Equals(network, "bridge", StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(network, "host", StringComparison.OrdinalIgnoreCase))
        {
            errors.Add(new("app_manifest_service_network_invalid", $"Service '{serviceKey}' network '{network}' must be 'bridge' or 'host'.", path));
            return;
        }

        if (string.Equals(network, "host", StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(runtimeType, "docker", StringComparison.Ordinal))
        {
            errors.Add(new("app_manifest_service_network_host_requires_docker", $"Service '{serviceKey}' network 'host' is only supported under the docker runtime.", path));
        }
    }

    // Validates cross-app dependencies: each needs a non-empty app id; each wired endpoint a
    // non-empty key; and the env aliases (HOSTY_DEPENDENCY_{ALIAS}_URL) must be unique across the
    // whole app so two wired endpoints never collide on the same injected variable. The dependency
    // app's existence and the endpoint's existence are NOT checked here (the dependency may not be
    // installed yet) — that surfaces as a start-time notification.
    private static void ValidateDependencies(IReadOnlyList<RuntimeAppDependencyManifest> dependencies, List<AppManifestValidationError> errors)
    {
        const string path = "$.dependencies";
        var seenAliases = new HashSet<string>(StringComparer.Ordinal);
        var seenIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var dependency in dependencies)
        {
            if (string.IsNullOrWhiteSpace(dependency.Id))
            {
                errors.Add(new("app_manifest_dependency_id_required", "dependencies[].id is required.", path));
            }
            else if (!seenIds.Add(dependency.Id))
            {
                // A duplicate id would also crash change-detection's ToDictionary(AppId); reject it here.
                errors.Add(new("app_manifest_dependency_duplicate_id", $"Dependency '{dependency.Id}' is declared more than once.", path));
            }

            foreach (var endpoint in dependency.Endpoints)
            {
                if (string.IsNullOrWhiteSpace(endpoint.Key))
                {
                    errors.Add(new("app_manifest_dependency_endpoint_key_required", $"Dependency '{dependency.Id}' has an endpoint with no key.", path));
                    continue;
                }

                var alias = RuntimePortHelper.NormalizeEnvironmentKey(endpoint.Alias);
                if (!seenAliases.Add(alias))
                {
                    errors.Add(new("app_manifest_dependency_alias_collision", $"Dependency endpoint alias '{endpoint.Alias}' normalizes to the same HOSTY_DEPENDENCY_ variable as another wired endpoint.", path));
                }
            }
        }
    }

    // Validates the one-shot `setup` command. localCommand runtime only — the docker runtime ships a
    // prebuilt image, so a host-side preparation step has no meaning there. Empty is fine (no setup).
    private static void ValidateSetup(string serviceKey, string runtimeType, string? setup, List<AppManifestValidationError> errors)
    {
        if (string.IsNullOrWhiteSpace(setup))
        {
            return;
        }

        if (!string.Equals(runtimeType, "localCommand", StringComparison.Ordinal))
        {
            errors.Add(new("app_manifest_service_setup_requires_local_command", $"Service '{serviceKey}' setup is only supported under the localCommand runtime.", "$.services[].runtimes[].setup"));
        }
    }

    // Validates the privileged `capabilities` list (`--cap-add`). Docker runtime only; each entry
    // must be a known Linux capability name (with or without the CAP_ prefix); no duplicates. These
    // widen container privilege, so they are surfaced for install review — see container-capabilities.md.
    private static void ValidateCapabilities(string serviceKey, string runtimeType, IReadOnlyList<string> capabilities, List<AppManifestValidationError> errors)
    {
        const string path = "$.services[].runtimes[].capabilities";
        if (capabilities.Count == 0)
        {
            return;
        }

        if (!string.Equals(runtimeType, "docker", StringComparison.Ordinal))
        {
            errors.Add(new("app_manifest_service_capabilities_require_docker", $"Service '{serviceKey}' capabilities are only supported under the docker runtime.", path));
            return;
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var capability in capabilities)
        {
            if (string.IsNullOrWhiteSpace(capability) || !LinuxCapabilities.IsKnown(capability))
            {
                errors.Add(new("app_manifest_service_capability_invalid", $"Service '{serviceKey}' capability '{capability}' is not a known Linux capability.", path));
            }
            else if (!seen.Add(LinuxCapabilities.Normalize(capability)))
            {
                errors.Add(new("app_manifest_service_capability_duplicate", $"Service '{serviceKey}' capability '{capability}' is declared more than once.", path));
            }
        }
    }

    // Validates the privileged `devices` list (`--device`). Docker runtime only; each entry must be
    // an absolute path under /dev (no `..`, no `:` mapping in v1 — host path == container path); no
    // duplicates. Surfaced for install review — see container-capabilities.md.
    private static void ValidateDevices(string serviceKey, string runtimeType, IReadOnlyList<string> devices, List<AppManifestValidationError> errors)
    {
        const string path = "$.services[].runtimes[].devices";
        if (devices.Count == 0)
        {
            return;
        }

        if (!string.Equals(runtimeType, "docker", StringComparison.Ordinal))
        {
            errors.Add(new("app_manifest_service_devices_require_docker", $"Service '{serviceKey}' devices are only supported under the docker runtime.", path));
            return;
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var device in devices)
        {
            var trimmed = device?.Trim() ?? string.Empty;
            if (!trimmed.StartsWith("/dev/", StringComparison.Ordinal) ||
                trimmed.EndsWith('/') ||
                trimmed.Contains("..", StringComparison.Ordinal) ||
                trimmed.Contains(':', StringComparison.Ordinal))
            {
                errors.Add(new("app_manifest_service_device_invalid", $"Service '{serviceKey}' device '{device}' must be an absolute path to a node under /dev (not a directory, no '..' or ':' mapping).", path));
            }
            else if (!seen.Add(trimmed))
            {
                errors.Add(new("app_manifest_service_device_duplicate", $"Service '{serviceKey}' device '{device}' is declared more than once.", path));
            }
        }
    }

    // Validates the opt-in raw-port fields. `Expose`/`Transport` only have meaning under the
    // docker runtime, but the values are validated for whichever runtime is selected so a
    // misconfiguration surfaces at install time rather than silently doing nothing. Under host
    // networking (`hostNetwork`) the container binds the host directly and Core emits no `-p`, so
    // the host-port pin requirement does not apply — the listener's port is the container port.
    private static void ValidatePorts(string serviceKey, IReadOnlyList<RuntimePortManifest> ports, bool hostNetwork, List<AppManifestValidationError> errors)
    {
        const string path = "$.services[].runtimes[].ports";
        foreach (var port in ports)
        {
            if (port.Expose is not null &&
                !string.Equals(port.Expose, "loopback", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(port.Expose, "host", StringComparison.OrdinalIgnoreCase))
            {
                errors.Add(new("app_manifest_port_expose_invalid", $"Service '{serviceKey}' port expose '{port.Expose}' must be 'loopback' or 'host'.", path));
            }

            if (port.Transport is not null)
            {
                if (port.Transport.Count == 0)
                {
                    errors.Add(new("app_manifest_port_transport_invalid", $"Service '{serviceKey}' port transport must list at least one of 'tcp' or 'udp' when declared.", path));
                }

                var seenTransports = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var transport in port.Transport)
                {
                    if (!string.Equals(transport, "tcp", StringComparison.OrdinalIgnoreCase) &&
                        !string.Equals(transport, "udp", StringComparison.OrdinalIgnoreCase))
                    {
                        errors.Add(new("app_manifest_port_transport_invalid", $"Service '{serviceKey}' port transport '{transport}' must be 'tcp' or 'udp'.", path));
                    }
                    else if (!seenTransports.Add(transport))
                    {
                        errors.Add(new("app_manifest_port_transport_duplicate", $"Service '{serviceKey}' port transport '{transport}' is declared more than once.", path));
                    }
                }
            }

            // A host-exposed port must pin its host port so router forwarding and the app's
            // advertised port stay constant across restarts (recommend hostPort == containerPort).
            // Skipped under host networking, where there is no `-p` mapping to keep stable.
            if (!hostNetwork &&
                string.Equals(port.Expose, "host", StringComparison.OrdinalIgnoreCase) &&
                port.LocalPort is null && port.HostPort is null)
            {
                errors.Add(new("app_manifest_port_host_requires_pinned_port", $"Service '{serviceKey}' port with expose 'host' must declare an explicit hostPort (recommended equal to containerPort) so router forwarding and the advertised port stay constant.", path));
            }
        }
    }

    internal static void ValidateHealthcheck(string serviceKey, string runtimeType, IReadOnlyList<RuntimePortManifest> ports, RuntimeServiceHealthcheckManifest? healthcheck, List<AppManifestValidationError> errors)
    {
        if (healthcheck is null)
        {
            return;
        }

        const string path = "$.services[].runtimes[].healthcheck";
        var type = healthcheck.Type;

        // Each runtime exposes the check mechanism it can actually honor: docker translates "exec" to a
        // container HEALTHCHECK; localCommand has no container, so Core probes "http"/"tcp" from the
        // host. Cross-runtime types are rejected rather than silently ignored.
        if (string.Equals(runtimeType, "docker", StringComparison.Ordinal))
        {
            if (type is not ("none" or "exec"))
            {
                errors.Add(new("app_manifest_healthcheck_type_invalid", $"Service '{serviceKey}' docker healthcheck.type must be 'none' or 'exec' (http/tcp probing applies to localCommand).", path));
            }

            if (string.Equals(type, "exec", StringComparison.Ordinal) && string.IsNullOrWhiteSpace(healthcheck.Command))
            {
                errors.Add(new("app_manifest_healthcheck_command_required", $"Service '{serviceKey}' healthcheck.type 'exec' requires a non-empty command.", path));
            }
        }
        else
        {
            if (type is not ("none" or "http" or "tcp"))
            {
                errors.Add(new("app_manifest_healthcheck_type_invalid", $"Service '{serviceKey}' localCommand healthcheck.type must be 'none', 'http', or 'tcp' (exec applies to docker).", path));
            }

            if (type is "http" or "tcp")
            {
                if (ports.Count == 0)
                {
                    errors.Add(new("app_manifest_healthcheck_port_required", $"Service '{serviceKey}' healthcheck.type '{type}' requires the service to declare at least one port to probe.", path));
                }
                else if (healthcheck.Port is int declaredPort && !ports.Any(candidate => candidate.ContainerPort == declaredPort))
                {
                    errors.Add(new("app_manifest_healthcheck_port_unknown", $"Service '{serviceKey}' healthcheck.port {declaredPort} does not match any declared container port.", path));
                }
            }
        }

        if (healthcheck.IntervalSeconds is <= 0)
        {
            errors.Add(new("app_manifest_healthcheck_interval_invalid", $"Service '{serviceKey}' healthcheck.intervalSeconds must be greater than zero.", path));
        }

        if (healthcheck.TimeoutSeconds is <= 0)
        {
            errors.Add(new("app_manifest_healthcheck_timeout_invalid", $"Service '{serviceKey}' healthcheck.timeoutSeconds must be greater than zero.", path));
        }

        if (healthcheck.Retries is <= 0)
        {
            errors.Add(new("app_manifest_healthcheck_retries_invalid", $"Service '{serviceKey}' healthcheck.retries must be greater than zero.", path));
        }

        if (healthcheck.GracePeriodSeconds is < 0)
        {
            errors.Add(new("app_manifest_healthcheck_grace_invalid", $"Service '{serviceKey}' healthcheck.gracePeriodSeconds must be zero or greater.", path));
        }
    }

}

internal interface IAppRuntimeAdapter
{
    string Type { get; }

    Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default);

    Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default);

    Task<AppRuntimeOperationResult> RemoveAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default);

    Task<AppRuntimeLogsResult> GetLogsAsync(RuntimeLifecycleContext context, int tail, CancellationToken cancellationToken = default);

    Task<AppRuntimeHealthResult> GetHealthAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default);
}

// Implemented by a runtime adapter that can resolve a compiled artifact's mutable pointer to its
// immutable identity remotely, without materializing it. The lifecycle service uses it at plan time
// to surface an artifact-digest change even when the manifest is byte-identical.
internal interface IImageDigestResolver
{
    Task<string?> ResolveRemoteDigestAsync(RuntimeDockerImage image, CancellationToken cancellationToken = default);
}

// Discovers which apps currently have a running Hosty-labelled container, so the supervisor can reconcile
// the "persisted stopped but actually running" drift (C-M1) that per-app health observation — which only
// probes apps Core already believes running — never catches.
internal interface IRunningContainerProbe
{
    Task<IReadOnlySet<string>> ListRunningAppIdsAsync(CancellationToken cancellationToken = default);
}

// Indirection over the `docker` CLI so the adapter's resolve/run/inspect logic is unit-testable
// without a daemon. Unlike RunDockerAsync it never throws on a non-zero exit — callers inspect
// ExitCode — but a missing CLI surfaces as DockerUnavailableException.
internal interface IDockerCommandRunner
{
    // `environment` is injected into the docker CLI process (not the argv), so secret-bearing values
    // referenced by `-e KEY` (name only) never appear in ps/`/proc/*/cmdline` (C-M5).
    Task<DockerCommandResult> RunAsync(IReadOnlyList<string> args, IReadOnlyDictionary<string, string>? environment = null, CancellationToken cancellationToken = default);
}

internal sealed record DockerCommandResult(int ExitCode, string StandardOutput, string StandardError);

internal sealed class DockerUnavailableException(string message) : Exception(message);

// Default runner: shells out to the `docker` CLI via the shared ProcessRunner (concurrent stream drain,
// kill-on-cancel, disposal). The absolute deadline is deliberately generous: docker control ops are
// quick, but `docker pull` can legitimately run for minutes on large images, so it only bounds a
// genuinely wedged daemon rather than a slow-but-progressing pull.
internal sealed class ProcessDockerCommandRunner(TimeSpan? timeout = null) : IDockerCommandRunner
{
    private readonly TimeSpan timeout = timeout ?? TimeSpan.FromMinutes(30);

    public async Task<DockerCommandResult> RunAsync(IReadOnlyList<string> args, IReadOnlyDictionary<string, string>? environment = null, CancellationToken cancellationToken = default)
    {
        var startInfo = new System.Diagnostics.ProcessStartInfo { FileName = "docker" };
        foreach (var arg in args)
        {
            startInfo.ArgumentList.Add(arg);
        }

        // Inject secret env values into the docker process (read by `-e KEY` name-only args), keeping
        // them out of the argv other local users can read via ps/`/proc/*/cmdline` (C-M5).
        if (environment is not null)
        {
            foreach (var pair in environment)
            {
                startInfo.Environment[pair.Key] = pair.Value;
            }
        }

        ProcessRunResult result;
        try
        {
            result = await ProcessRunner.RunAsync(startInfo, timeout, cancellationToken);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            throw new DockerUnavailableException(ex.Message);
        }

        if (result.TimedOut)
        {
            throw new DockerUnavailableException($"docker command timed out after {timeout.TotalSeconds:0}s: docker {string.Join(' ', args)}");
        }

        return new DockerCommandResult(result.ExitCode, result.StandardOutput, result.StandardError);
    }
}

internal sealed class DockerRuntimeAdapter(
    HostyCoreRuntimeConfig config,
    AppServiceTokenService serviceTokens,
    ILogger<DockerRuntimeAdapter> logger,
    IDockerCommandRunner? dockerRunner = null) : IAppRuntimeAdapter, IImageDigestResolver, IRunningContainerProbe
{
    // App ids already advised about WSL2 P2P throttling, so the warning is logged once per app
    // per Core process rather than on every (health-driven) restart. Instance field on the DI
    // singleton: its lifetime is the process, and it is bounded by the number of distinct apps
    // ever started (small), so it does not need explicit eviction.
    private readonly ConcurrentDictionary<string, byte> wslMirroredAdvised = new(StringComparer.Ordinal);

    // Kernel info files whose contents mark a WSL2 environment; allocated once, not per check.
    private static readonly string[] WslKernelInfoPaths = ["/proc/sys/kernel/osrelease", "/proc/version"];

    // Indirection over the `docker` CLI so the resolve/run/inspect logic is unit-testable without a
    // daemon. DI never registers one, so production uses the process runner; tests inject a fake.
    private readonly IDockerCommandRunner runner = dockerRunner ?? new ProcessDockerCommandRunner();

    public string Type => "docker";

    public async Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
    {
        var endpoints = new List<AppEndpointContract>();
        var services = OrderServices(context.Manifest.Services);
        var resolvedLocks = new Dictionary<string, ArtifactLock>(StringComparer.Ordinal);
        var policy = ResolveUpdatePolicy(context.App.UpdatePolicy);

        MaybeAdviseWslMirroredNetworking(context, services);

        // Siblings that `dependsOn` one another reach each other by service-name DNS over a
        // per-app user network, so the internal port never needs host publishing. Containers
        // run standalone otherwise, so only create the network when discovery is actually used.
        var dependencyNetwork = RequiresUserNetwork(services) ? BuildNetworkName(context.App.Id) : null;
        if (dependencyNetwork is not null)
        {
            _ = await RunDockerAsync(["network", "create", dependencyNetwork], ignoreFailures: true, cancellationToken);
        }

        // Track containers this start actually created so a later service failing can unwind them (C-H5):
        // otherwise service B failing leaves service A running while the record is recorded stopped, and
        // the health observer (which only probes persisted-running apps) never reconciles it.
        var startedContainers = new List<string>();
        try
        {
        foreach (var service in services)
        {
            if (service.Image is null)
            {
                throw new AppLifecycleException("runtime_profile_invalid", $"Docker service '{service.Key}' does not declare an image.");
            }

            var hostNetwork = service.Runtime.IsHostNetwork;
            var containerName = BuildContainerName(context.App.Id, service.Key);
            await RemoveContainerIfOwnedAsync(context.App.Id, containerName, cancellationToken);

            // Resolve what to run from the lock + policy instead of blindly running the mutable tag:
            // pinned reuses the locked digest (pulling it only if missing), rolling re-resolves the
            // tag and advances the lock, and a lockless app is backfilled (TOFU). See A3/A4/A8.
            var existingLock = context.App.ArtifactLocks?.GetValueOrDefault(service.Key);
            var (runReference, resolvedLock) = await ResolveImageRunReferenceAsync(service.Image, existingLock, policy, cancellationToken);
            resolvedLocks[service.Key] = resolvedLock;

            // Secret-bearing env (app settings + the service token) is passed by NAME on the argv and by
            // VALUE through the docker process environment, so the values never land in ps/cmdline (C-M5).
            var containerEnvironment = new Dictionary<string, string>(StringComparer.Ordinal);

            var runArgs = new List<string>
            {
                "run",
                "-d",
                "--name",
                containerName,
                "--restart",
                "no",
                "--add-host",
                "host.docker.internal:host-gateway",
                "--label",
                $"hosty.app.id={context.App.Id}",
                "--label",
                $"hosty.app.service={service.Key}",
                "-e",
                $"HOSTY_APP_ID={context.App.Id}",
                "-e",
                $"HOSTY_APP_SERVICE_KEY={service.Key}",
            };
            if (hostNetwork)
            {
                // Host networking shares the host's network namespace: the container's listeners
                // bind the host interfaces directly (no NAT, no `-p`). It is mutually exclusive
                // with a user network, so siblings reach this service via host.docker.internal at
                // its container port (see BuildDockerServiceUrl) rather than a network alias.
                runArgs.Add("--network");
                runArgs.Add("host");
            }
            else if (dependencyNetwork is not null)
            {
                // The service key is a DNS-safe contract key, used directly as the network alias
                // so siblings resolve `http://{service.Key}:{containerPort}`.
                runArgs.Add("--network");
                runArgs.Add(dependencyNetwork);
                runArgs.Add("--network-alias");
                runArgs.Add(service.Key);
            }

            // Privileged extras (validated + install-review gated): Linux capabilities and host
            // device nodes, e.g. NET_ADMIN + /dev/net/tun for an in-container VPN.
            runArgs.AddRange(BuildPrivilegedArguments(service.Runtime));
            runArgs.AddRange(BuildHealthcheckArguments(service.Runtime));

            foreach (var environment in BuildDockerCoreEnvironment(config))
            {
                runArgs.Add("-e");
                runArgs.Add(environment);
            }

            foreach (var setting in context.App.Settings.Values)
            {
                if (!string.IsNullOrWhiteSpace(setting.Value))
                {
                    runArgs.Add("-e");
                    runArgs.Add(setting.Key);
                    containerEnvironment[setting.Key] = setting.Value!;
                }
            }

            foreach (var environment in service.Runtime.Environment)
            {
                runArgs.Add("-e");
                runArgs.Add($"{environment.Key}={environment.Value}");
            }

            runArgs.Add("-e");
            runArgs.Add("HOSTY_APP_SERVICE_TOKEN");
            containerEnvironment["HOSTY_APP_SERVICE_TOKEN"] = serviceTokens.CreateToken(context.App.Id);

            foreach (var telemetry in BuildTelemetryEnvironment(context, service.Key))
            {
                runArgs.Add("-e");
                runArgs.Add(telemetry);
            }

            foreach (var dependency in context.DependencyUrls)
            {
                runArgs.Add("-e");
                // A dependency endpoint published on the host's loopback is unreachable from inside
                // this container, so rewrite a loopback URL to host.docker.internal (same rewrite
                // used for HOSTY_CORE_ORIGIN). The dependency must publish the endpoint host-reachable
                // (expose:host) for this to connect — see cross-app-dependencies.md.
                runArgs.Add($"HOSTY_DEPENDENCY_{RuntimePortHelper.NormalizeEnvironmentKey(dependency.Key)}_URL={BuildDockerCoreOrigin(dependency.Value)}");
            }

            foreach (var serviceUrl in RuntimeServiceDiscovery.BuildEnvironment(services, service, BuildDockerServiceUrl))
            {
                runArgs.Add("-e");
                runArgs.Add($"{serviceUrl.Key}={serviceUrl.Value}");
            }

            var assignedPorts = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var port in service.Runtime.Ports)
            {
                if (port.ContainerPort is null)
                {
                    continue;
                }

                var key = port.Key ?? port.ContainerPort.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
                // Under host networking the listener binds the host directly on its container port,
                // so that *is* the reachable host port — there is nothing to publish or allocate.
                var hostPort = hostNetwork
                    ? port.ContainerPort.Value
                    : RuntimePortHelper.ResolveHostPort(context, service.Key, port, key);
                assignedPorts[key] = hostPort;
                runArgs.AddRange(BuildPortArguments(port, hostPort, port.ContainerPort.Value, hostNetwork));
            }

            if (context.Manifest.DataTarget is not null &&
                (string.IsNullOrWhiteSpace(context.Manifest.DataTarget.Service) ||
                    string.Equals(context.Manifest.DataTarget.Service, service.Key, StringComparison.Ordinal)))
            {
                var containerPath = string.IsNullOrWhiteSpace(context.Manifest.DataTarget.ContainerPath)
                    ? "/app/data"
                    : context.Manifest.DataTarget.ContainerPath;
                var environmentName = string.IsNullOrWhiteSpace(context.Manifest.DataTarget.Environment)
                    ? "HOSTY_APP_DATA_DIR"
                    : context.Manifest.DataTarget.Environment;

                Directory.CreateDirectory(context.AppDataPath);
                runArgs.Add("-v");
                runArgs.Add($"{context.AppDataPath}:{containerPath}");
                runArgs.Add("-e");
                runArgs.Add($"{environmentName}={containerPath}");
            }

            var serviceMounts = RuntimeMountPlanner.ForService(context.Mounts, service.Key);
            runArgs.AddRange(RuntimeMountPlanner.BuildDockerVolumeArguments(serviceMounts));
            foreach (var mountEnvironment in RuntimeMountPlanner.BuildMountEnvironment(serviceMounts, useContainerPath: true))
            {
                runArgs.Add("-e");
                runArgs.Add($"{mountEnvironment.Key}={mountEnvironment.Value}");
            }

            runArgs.Add(runReference);
            _ = await RunDockerAsync(runArgs, ignoreFailures: false, cancellationToken, environment: containerEnvironment);
            startedContainers.Add(containerName);

            foreach (var port in service.Runtime.Ports.Where(port => port.ContainerPort is not null))
            {
                var key = port.Key ?? port.ContainerPort!.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
                if (!assignedPorts.TryGetValue(key, out var hostPort))
                {
                    continue;
                }

                endpoints.Add(new AppEndpointContract(
                    Key: $"{service.Key}.{key}",
                    Protocol: string.IsNullOrWhiteSpace(port.Protocol) ? "http" : port.Protocol,
                    Url: $"{(string.IsNullOrWhiteSpace(port.Protocol) ? "http" : port.Protocol)}://{config.RuntimePublicHost}:{hostPort}",
                    Public: port.Public ?? false,
                    Service: service.Key,
                    Port: key));
            }
        }
        }
        catch
        {
            // Unwind the partial start: remove the containers we created (owned-checked) and drop the
            // per-app network if we created it, so a failed multi-service start leaves nothing running.
            foreach (var containerName in startedContainers)
            {
                await RemoveContainerIfOwnedAsync(context.App.Id, containerName, CancellationToken.None);
            }

            if (dependencyNetwork is not null)
            {
                _ = await RunDockerAsync(["network", "rm", dependencyNetwork], ignoreFailures: true, CancellationToken.None);
            }

            throw;
        }

        return new AppRuntimeStartResult("running", endpoints, resolvedLocks);
    }

    public async Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
    {
        var stillRunning = new List<string>();
        foreach (var service in context.Manifest.Services)
        {
            var containerName = BuildContainerName(context.App.Id, service.Key);
            _ = await RunDockerAsync(["stop", containerName], ignoreFailures: true, cancellationToken);
            if (await IsContainerRunningAsync(containerName, cancellationToken))
            {
                stillRunning.Add(containerName);
            }
        }

        if (stillRunning.Count > 0)
        {
            // Never report "stopped" while a container is actually still running: that is the exact drift
            // where the record says stopped, health observation (which only probes persisted-running apps)
            // skips it, and it stays wrong forever (C-M1). Surface a failure so the record stays truthful.
            throw new AppLifecycleException(
                "docker_stop_incomplete",
                $"docker stop did not stop container(s): {string.Join(", ", stillRunning)}.");
        }

        return new AppRuntimeOperationResult("stopped");
    }

    public async Task<AppRuntimeOperationResult> RemoveAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
    {
        foreach (var service in context.Manifest.Services)
        {
            await RemoveContainerIfOwnedAsync(context.App.Id, BuildContainerName(context.App.Id, service.Key), cancellationToken);
        }

        // Drop the per-app discovery network (no-op when it was never created); containers are
        // already removed above so detachment cannot fail.
        _ = await RunDockerAsync(["network", "rm", BuildNetworkName(context.App.Id)], ignoreFailures: true, cancellationToken);

        return new AppRuntimeOperationResult("removed");
    }

    public async Task<AppRuntimeLogsResult> GetLogsAsync(RuntimeLifecycleContext context, int tail, CancellationToken cancellationToken = default)
    {
        var services = new List<AppRuntimeServiceLogs>();
        var lines = new List<string>();
        foreach (var service in context.Manifest.Services)
        {
            var output = await RunDockerAsync(
                ["logs", "--tail", Math.Clamp(tail, 1, 1000).ToString(System.Globalization.CultureInfo.InvariantCulture), BuildContainerName(context.App.Id, service.Key)],
                ignoreFailures: true,
                cancellationToken);
            var text = string.IsNullOrWhiteSpace(output) ? string.Empty : output.TrimEnd();
            services.Add(new AppRuntimeServiceLogs(service.Key, text));
            if (text.Length > 0)
            {
                lines.Add($"== {service.Key} ==");
                lines.Add(text);
            }
        }

        return new AppRuntimeLogsResult(string.Join(Environment.NewLine, lines), services);
    }

    public async Task<AppRuntimeHealthResult> GetHealthAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
    {
        var services = new List<AppRuntimeServiceHealth>();
        foreach (var service in context.Manifest.Services)
        {
            services.Add(await InspectServiceHealthAsync(context.App.Id, service.Key, cancellationToken));
        }

        return new AppRuntimeHealthResult(SummarizeHealthStatus(services), services);
    }

    // Aggregate container statuses into one app status. Liveness (Status) decides first; the
    // container HEALTHCHECK signal (Health) only refines the all-running case so existing outcomes
    // are unchanged: all stopped -> stopped; some up + some down -> unhealthy (partial outage);
    // otherwise unknown. New, additive: all up but any failing its healthcheck -> degraded; all up
    // but any still starting -> starting; all up and healthy/no-healthcheck -> healthy.
    internal static string SummarizeHealthStatus(IReadOnlyList<AppRuntimeServiceHealth> services)
    {
        if (services.Count == 0)
        {
            return "unknown";
        }

        if (services.All(service => string.Equals(service.Status, "running", StringComparison.Ordinal)))
        {
            if (services.Any(service => string.Equals(service.Health, "unhealthy", StringComparison.Ordinal)))
            {
                return "degraded";
            }

            if (services.Any(service => string.Equals(service.Health, "starting", StringComparison.Ordinal)))
            {
                return "starting";
            }

            return "healthy";
        }

        if (services.All(service => string.Equals(service.Status, "stopped", StringComparison.Ordinal)))
        {
            return "stopped";
        }

        return services.Any(service => string.Equals(service.Status, "running", StringComparison.Ordinal))
            ? "unhealthy"
            : "unknown";
    }

    // Inspects a single service container in one `docker inspect` call, then resolves the running
    // image's first repo digest (`repository@sha256:...`) so clients can detect "running != lock"
    // drift on rolling apps. A missing container or unavailable docker is reported as "stopped" —
    // health is best-effort observation and never throws.
    private async Task<AppRuntimeServiceHealth> InspectServiceHealthAsync(string appId, string serviceKey, CancellationToken cancellationToken)
    {
        var containerName = BuildContainerName(appId, serviceKey);
        // Tab-separated so an empty middle field cannot shift columns. {{.Image}} is the image id;
        // {{.Config.Image}} is the reference the container was launched with (the pinned digest).
        // {{if .State.Health}} guards the health field: .State.Health is nil when the image declares
        // no HEALTHCHECK, and an unguarded {{.State.Health.Status}} would error out the whole inspect.
        // RestartCount and StartedAt are observation-only signals for uptime / crash-loop legibility.
        const string format = "{{.State.Status}}\t{{.State.Pid}}\t{{.State.ExitCode}}\t{{.Image}}\t{{.Config.Image}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}\t{{.RestartCount}}\t{{.State.StartedAt}}";
        var inspect = await RunRawAsync(["inspect", "--format", format, containerName], cancellationToken);
        if (inspect.ExitCode != 0)
        {
            return new AppRuntimeServiceHealth(serviceKey, "stopped", null, null, null, null, null);
        }

        var parsed = ParseContainerInspect(inspect.StandardOutput);
        var image = parsed.ConfigImage;
        if (!string.IsNullOrWhiteSpace(parsed.ImageId))
        {
            var repoDigest = await ResolveImageRepoDigestAsync(parsed.ImageId!, cancellationToken);
            if (!string.IsNullOrWhiteSpace(repoDigest))
            {
                image = repoDigest;
            }
        }

        return new AppRuntimeServiceHealth(
            Service: serviceKey,
            Status: parsed.Status,
            ProcessId: parsed.Pid,
            ExitCode: parsed.ExitCode,
            LogPath: null,
            WorkingDirectory: null,
            Message: null,
            Image: string.IsNullOrWhiteSpace(image) ? null : image,
            Health: parsed.Health,
            RestartCount: parsed.RestartCount,
            StartedAt: parsed.StartedAt);
    }

    // Parses the tab-separated `docker inspect` line above. Maps docker's container state to the
    // "running"/"stopped" vocabulary the rest of Core uses (anything not actively running is stopped).
    internal static ContainerInspectInfo ParseContainerInspect(string output)
    {
        var fields = (output ?? string.Empty).Trim().Split('\t');
        var rawStatus = fields.Length > 0 ? fields[0].Trim() : string.Empty;
        var status = string.Equals(rawStatus, "running", StringComparison.OrdinalIgnoreCase) ? "running" : "stopped";
        int? pid = fields.Length > 1 && int.TryParse(fields[1].Trim(), out var p) && p > 0 ? p : null;
        int? exitCode = fields.Length > 2 && int.TryParse(fields[2].Trim(), out var c) ? c : null;
        var imageId = fields.Length > 3 ? NullIfBlank(fields[3]) : null;
        var configImage = fields.Length > 4 ? NullIfBlank(fields[4]) : null;
        // Container HEALTHCHECK result; blank (the `{{if .State.Health}}` guard) means the image
        // declares no healthcheck, which is no signal rather than a failure.
        var health = fields.Length > 5 ? NormalizeHealth(fields[5]) : null;
        int? restartCount = fields.Length > 6 && int.TryParse(fields[6].Trim(), out var r) && r >= 0 ? r : null;
        var startedAt = fields.Length > 7 ? NullIfNeverStarted(fields[7]) : null;
        return new ContainerInspectInfo(status, pid, exitCode, imageId, configImage, health, restartCount, startedAt);
    }

    // Normalizes docker's health status to a lowercase {healthy|unhealthy|starting}; anything else
    // (blank, "none", unrecognized) is null so "no healthcheck" reads as no signal, not a failure.
    internal static string? NormalizeHealth(string? value)
        => (value ?? string.Empty).Trim().ToLowerInvariant() switch
        {
            "healthy" => "healthy",
            "unhealthy" => "unhealthy",
            "starting" => "starting",
            _ => null,
        };

    // Docker reports the zero value "0001-01-01T00:00:00Z" for a container that never started.
    private static string? NullIfNeverStarted(string? value)
    {
        var trimmed = (value ?? string.Empty).Trim();
        return trimmed.Length == 0 || trimmed.StartsWith("0001-01-01", StringComparison.Ordinal) ? null : trimmed;
    }

    internal sealed record ContainerInspectInfo(
        string Status,
        int? Pid,
        int? ExitCode,
        string? ImageId,
        string? ConfigImage,
        string? Health = null,
        int? RestartCount = null,
        string? StartedAt = null);

    // Resolves the reference to actually run and the lock to persist, from the manifest image, any
    // existing per-service lock, and the app's update policy. See runtime-app-marketplace.md
    // ("Start / restart" and "Core start (lock backfill)"):
    //   - pinned + existing digest: run the locked digest, pulling it only if absent (deterministic).
    //   - rolling, or pinned with no lock (legacy/TOFU backfill): pull the tag, resolve its digest,
    //     run the digest, and record the advanced lock.
    private async Task<(string RunReference, ArtifactLock Lock)> ResolveImageRunReferenceAsync(
        RuntimeDockerImage image,
        ArtifactLock? existingLock,
        string policy,
        CancellationToken cancellationToken)
    {
        if (string.Equals(policy, "pinned", StringComparison.Ordinal) &&
            !string.IsNullOrWhiteSpace(existingLock?.ImageDigest))
        {
            var pinnedReference = (image with { Digest = existingLock!.ImageDigest }).Reference;
            if (!await ImageExistsLocallyAsync(pinnedReference, cancellationToken))
            {
                _ = await RunDockerAsync(["pull", pinnedReference], ignoreFailures: false, cancellationToken);
            }

            return (pinnedReference, existingLock);
        }

        // rolling, or first resolve / backfill: pull the mutable tag and capture the resolved digest.
        var tagReference = image.TagReference;
        string? pullOutput = null;
        AppLifecycleException? pullFailure = null;
        try
        {
            pullOutput = await RunDockerAsync(["pull", tagReference], ignoreFailures: false, cancellationToken);
        }
        catch (AppLifecycleException ex)
        {
            pullFailure = ex;
        }

        // Offline or a local-only image (e.g. built locally during development): the pull failed but
        // the tag is already present, so resolve its digest from the local image and run it instead of
        // blocking start. A genuinely-absent image rethrows the original failure. (Can't await in a
        // catch filter, so the fallback check runs here.)
        if (pullFailure is not null && !await ImageExistsLocallyAsync(tagReference, cancellationToken))
        {
            throw pullFailure;
        }

        var digest = ParsePullDigest(pullOutput) ?? await ResolveRepoDigestByTagAsync(tagReference, cancellationToken);
        if (string.IsNullOrWhiteSpace(digest))
        {
            // A local-only image may have no repo digest; run the tag as-is and record a lock that
            // still captures the resolved-from ref so the policy/plan machinery has something to show.
            return (tagReference, new ArtifactLock("image", null, tagReference, null, null, DateTimeOffset.UtcNow));
        }

        var runReference = (image with { Digest = digest }).Reference;
        return (runReference, new ArtifactLock("image", digest, tagReference, null, null, DateTimeOffset.UtcNow));
    }

    // Runs a docker command for its exit code without throwing when the CLI is unavailable: the
    // resolve/inspect helpers treat "could not run" identically to a non-zero exit, so a missing
    // daemon degrades to "not present"/"unknown" rather than crashing health or a pinned restart.
    private async Task<DockerCommandResult> RunRawAsync(IReadOnlyList<string> args, CancellationToken cancellationToken)
    {
        try
        {
            return await runner.RunAsync(args, cancellationToken: cancellationToken);
        }
        catch (DockerUnavailableException ex)
        {
            return new DockerCommandResult(127, string.Empty, ex.Message);
        }
    }

    // BuildContainerName normalizes every non-alphanumeric char to '-', so `my.app` and `my-app` (and
    // app `x-y`/service `z` vs app `x`/service `y-z`) collide on the same container name. A blind
    // `docker rm -f <name>` could therefore destroy a *different* app's — or a user's — container that
    // happens to share the normalized name. Only remove when the container carries this app's
    // hosty.app.id label; a mismatch is left in place (the later `docker run --name` surfaces a clear
    // name-conflict error) and an absent container is a no-op (C-M2).
    private async Task RemoveContainerIfOwnedAsync(string appId, string containerName, CancellationToken cancellationToken)
    {
        var inspect = await RunRawAsync(["inspect", "--format", "{{ index .Config.Labels \"hosty.app.id\" }}", containerName], cancellationToken);
        if (inspect.ExitCode != 0)
        {
            return;
        }

        var owner = inspect.StandardOutput.Trim();
        if (!string.Equals(owner, appId, StringComparison.Ordinal))
        {
            logger.LogWarning(
                "Not removing container '{Container}': it is labelled for app '{Owner}', not '{AppId}'. A docker name conflict will surface instead of destroying another app's container.",
                containerName, string.IsNullOrEmpty(owner) ? "<none>" : owner, appId);
            return;
        }

        _ = await RunDockerAsync(["rm", "-f", containerName], ignoreFailures: true, cancellationToken);
    }

    private async Task<bool> IsContainerRunningAsync(string containerName, CancellationToken cancellationToken)
    {
        var inspect = await RunRawAsync(["inspect", "--format", "{{.State.Running}}", containerName], cancellationToken);
        return inspect.ExitCode == 0 &&
            string.Equals(inspect.StandardOutput.Trim(), "true", StringComparison.OrdinalIgnoreCase);
    }

    // Reports the app ids that currently own a running Hosty-labelled container. One `docker ps` per
    // supervision tick (not per app); `{{.Label "..."}}` prints the label value per running container.
    public async Task<IReadOnlySet<string>> ListRunningAppIdsAsync(CancellationToken cancellationToken = default)
    {
        var result = await RunRawAsync(
            ["ps", "--filter", "label=hosty.app.id", "--format", "{{.Label \"hosty.app.id\"}}"],
            cancellationToken);
        if (result.ExitCode != 0)
        {
            return new HashSet<string>(StringComparer.Ordinal);
        }

        return result.StandardOutput
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToHashSet(StringComparer.Ordinal);
    }

    // True when the reference is already present in the local image store (so a pinned restart need
    // not hit the registry). `docker image inspect` exits non-zero when the image is absent.
    private async Task<bool> ImageExistsLocallyAsync(string reference, CancellationToken cancellationToken)
        => (await RunRawAsync(["image", "inspect", reference], cancellationToken)).ExitCode == 0;

    // Reads a pulled tag's first repo digest via `docker inspect`, used when the pull output did not
    // carry a `Digest:` line. Returns the `sha256:...` portion, or null if unavailable.
    private async Task<string?> ResolveRepoDigestByTagAsync(string tagReference, CancellationToken cancellationToken)
    {
        var result = await RunRawAsync(["inspect", "--format", "{{index .RepoDigests 0}}", tagReference], cancellationToken);
        return result.ExitCode == 0 ? ParseRepoDigest(result.StandardOutput) : null;
    }

    // Reads an image id's first repo digest (`repository@sha256:...`) for health reporting.
    private async Task<string?> ResolveImageRepoDigestAsync(string imageId, CancellationToken cancellationToken)
    {
        var result = await RunRawAsync(["inspect", "--format", "{{index .RepoDigests 0}}", imageId], cancellationToken);
        if (result.ExitCode != 0)
        {
            return null;
        }

        var value = result.StandardOutput?.Trim();
        return string.IsNullOrWhiteSpace(value) || value.Contains("no value", StringComparison.OrdinalIgnoreCase) ? null : value;
    }

    // Light remote digest lookup for the reviewed-update plan: resolves `repository:tag` to its index
    // digest WITHOUT a full pull (A4). Returns the `sha256:...` digest, or null when the registry is
    // unreachable/unresolvable — the plan then marks the artifact delta "unknown" and the full pull
    // happens at apply. Tries `buildx imagetools` (multi-arch index digest) then `manifest inspect`.
    public async Task<string?> ResolveRemoteDigestAsync(RuntimeDockerImage image, CancellationToken cancellationToken = default)
    {
        var tagReference = image.TagReference;
        var imagetools = await RunRawAsync(
            ["buildx", "imagetools", "inspect", "--format", "{{.Manifest.Digest}}", tagReference],
            cancellationToken);
        if (imagetools.ExitCode == 0 && ParseSha256(imagetools.StandardOutput) is { } digest)
        {
            return digest;
        }

        var manifest = await RunRawAsync(["manifest", "inspect", "--verbose", tagReference], cancellationToken);
        return manifest.ExitCode == 0 ? ParseManifestInspectDigest(manifest.StandardOutput) : null;
    }

    // Parses the `Digest: sha256:...` line docker prints during a pull. Returns `sha256:...` or null.
    internal static string? ParsePullDigest(string? pullOutput)
    {
        if (string.IsNullOrWhiteSpace(pullOutput))
        {
            return null;
        }

        foreach (var line in pullOutput.Split('\n'))
        {
            var trimmed = line.Trim();
            if (trimmed.StartsWith("Digest:", StringComparison.OrdinalIgnoreCase))
            {
                return ParseSha256(trimmed["Digest:".Length..]);
            }
        }

        return null;
    }

    // Extracts the `sha256:...` portion from a repo digest reference (`repository@sha256:...`) as
    // emitted by `docker inspect --format '{{index .RepoDigests 0}}'`. Returns null if absent.
    internal static string? ParseRepoDigest(string? repoDigest)
    {
        if (string.IsNullOrWhiteSpace(repoDigest))
        {
            return null;
        }

        var trimmed = repoDigest.Trim();
        var at = trimmed.LastIndexOf('@');
        return at >= 0 ? ParseSha256(trimmed[(at + 1)..]) : ParseSha256(trimmed);
    }

    // `docker manifest inspect --verbose` returns either an object (single manifest) with a
    // `Descriptor.digest`, or an array (manifest list) of per-platform entries. The pull lock is the
    // index digest, which the array form does not expose reliably, so only the object form resolves.
    internal static string? ParseManifestInspectDigest(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind == JsonValueKind.Object &&
                document.RootElement.TryGetProperty("Descriptor", out var descriptor) &&
                descriptor.ValueKind == JsonValueKind.Object &&
                descriptor.TryGetProperty("digest", out var digest) &&
                digest.ValueKind == JsonValueKind.String)
            {
                return ParseSha256(digest.GetString());
            }
        }
        catch (JsonException)
        {
            // Unexpected output shape: treat as unresolved rather than failing the plan.
        }

        return null;
    }

    // Normalizes a candidate digest string to a `sha256:<hex>` token, or null if it is not one.
    private static string? ParseSha256(string? value)
    {
        var trimmed = value?.Trim();
        if (string.IsNullOrWhiteSpace(trimmed))
        {
            return null;
        }

        // Tolerate surrounding tokens (e.g. a whole reference) by locating the algorithm prefix.
        var index = trimmed.IndexOf("sha256:", StringComparison.OrdinalIgnoreCase);
        if (index < 0)
        {
            return null;
        }

        var candidate = trimmed[index..];
        var end = candidate.IndexOfAny([' ', '\t', '\r', '\n', '"']);
        if (end >= 0)
        {
            candidate = candidate[..end];
        }

        // sha256: + 64 lowercase hex chars.
        return candidate.Length == "sha256:".Length + 64 ? candidate.ToLowerInvariant() : null;
    }

    // The app-level pull/lock policy: pinned (default) or rolling. Anything unrecognized (or null)
    // is treated as pinned — the safe, deterministic default.
    internal static string ResolveUpdatePolicy(string? policy)
        => string.Equals(policy, "rolling", StringComparison.OrdinalIgnoreCase) ? "rolling" : "pinned";

    private static string? NullIfBlank(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static IReadOnlyList<RuntimeSelectedService> OrderServices(IReadOnlyList<RuntimeSelectedService> services)
    {
        var remaining = services.ToDictionary(service => service.Key, StringComparer.Ordinal);
        var ordered = new List<RuntimeSelectedService>();
        while (remaining.Count > 0)
        {
            var ready = remaining.Values
                .Where(service => service.DependsOn.All(dependency => !remaining.ContainsKey(dependency.Service)))
                .OrderBy(service => service.Key, StringComparer.Ordinal)
                .ToArray();
            if (ready.Length == 0)
            {
                throw new AppLifecycleException("runtime_dependency_cycle", "Runtime service dependency graph contains a cycle.");
            }

            foreach (var service in ready)
            {
                remaining.Remove(service.Key);
                ordered.Add(service);
            }
        }

        return ordered;
    }

    // Runs a docker command through the injected runner and returns stdout, throwing on a non-zero
    // exit (or unavailable docker) unless ignoreFailures. The exit-code-aware resolve/inspect helpers
    // call the runner directly; this wrapper preserves the throw-on-failure semantics callers rely on.
    private async Task<string> RunDockerAsync(IReadOnlyList<string> args, bool ignoreFailures, CancellationToken cancellationToken, IReadOnlyDictionary<string, string>? environment = null)
    {
        DockerCommandResult result;
        try
        {
            result = await runner.RunAsync(args, environment, cancellationToken);
        }
        catch (DockerUnavailableException) when (ignoreFailures)
        {
            return string.Empty;
        }
        catch (DockerUnavailableException ex)
        {
            throw new AppLifecycleException("docker_unavailable", $"Docker CLI is not available: {ex.Message}");
        }

        if (result.ExitCode != 0 && !ignoreFailures)
        {
            throw new AppLifecycleException(
                "docker_operation_failed",
                string.IsNullOrWhiteSpace(result.StandardError) ? $"Docker exited with code {result.ExitCode}." : result.StandardError.Trim());
        }

        return result.StandardOutput;
    }

    internal static string BuildContainerName(string appId, string serviceKey)
        => $"hosty-{NormalizeDockerName(appId)}-{NormalizeDockerName(serviceKey)}";

    internal static string BuildNetworkName(string appId)
        => $"hosty-{NormalizeDockerName(appId)}-net";

    // A user network is only needed when some service `dependsOn` another, i.e. when intra-app
    // service-name DNS is actually used; single-service and ordering-free apps stay standalone.
    internal static bool RequiresUserNetwork(IReadOnlyList<RuntimeSelectedService> services)
        => services.Any(service => service.DependsOn.Count > 0);

    // Discovery URL for the docker runtime: reach the sibling by its network alias (service key)
    // at its container port, over the per-app user network — no host publishing of the port. A
    // host-networked sibling is not on the user network, so it is reached via host.docker.internal
    // at its container port (which it binds directly on the host under `--network host`).
    internal static string BuildDockerServiceUrl(RuntimeSelectedService service, RuntimePortManifest port)
        => service.Runtime.IsHostNetwork
            ? $"{RuntimeServiceDiscovery.Scheme(port)}://host.docker.internal:{port.ContainerPort}"
            : $"{RuntimeServiceDiscovery.Scheme(port)}://{service.Key}:{port.ContainerPort}";

    // Transport used when a port opts into the new publish format without naming one.
    private static readonly IReadOnlyList<string> DefaultTransports = ["tcp"];

    // Builds the docker `run` arguments that publish a single port and inject its HOSTY_PORT_*.
    // A port that declares neither `expose` nor `transport` keeps the exact legacy publish
    // (`127.0.0.1:{host}:{container}`, no protocol suffix) so existing apps are byte-for-byte
    // unaffected. Opting into either field switches to explicit `bind:host:container/proto`
    // publishing — `0.0.0.0` for `expose:host`, one `-p` per transport (tcp/udp). HOSTY_PORT_*
    // is injected exactly once regardless of how many transports are published. Under host
    // networking no `-p` is emitted (docker discards published ports with `--network host`); only
    // HOSTY_PORT_* is injected, carrying the container port the listener already binds on the host.
    internal static IReadOnlyList<string> BuildPortArguments(RuntimePortManifest port, int hostPort, int containerPort, bool hostNetwork = false)
    {
        var args = new List<string>();
        if (!hostNetwork)
        {
            foreach (var publish in BuildPortPublishValues(port, hostPort, containerPort))
            {
                args.Add("-p");
                args.Add(publish);
            }
        }

        if (!string.IsNullOrWhiteSpace(port.Key))
        {
            args.Add("-e");
            args.Add($"HOSTY_PORT_{RuntimePortHelper.NormalizeEnvironmentKey(port.Key)}={hostPort}");
        }

        return args;
    }

    private static IEnumerable<string> BuildPortPublishValues(RuntimePortManifest port, int hostPort, int containerPort)
    {
        // Legacy publish only when BOTH opt-in fields are truly absent. An explicit transport
        // list (even an empty one, which validation rejects) counts as opting in and falls
        // through to the explicit `bind:host:container/proto` form below.
        if (port.Expose is null && port.Transport is null)
        {
            return [$"127.0.0.1:{hostPort}:{containerPort}"];
        }

        var bind = string.Equals(port.Expose, "host", StringComparison.OrdinalIgnoreCase)
            ? "0.0.0.0"
            : "127.0.0.1";
        var transports = port.Transport is { Count: > 0 } declared ? declared : DefaultTransports;
        return transports.Select(transport => $"{bind}:{hostPort}:{containerPort}/{transport.ToLowerInvariant()}");
    }

    // Warns once per app when a peer-to-peer-shaped service (host networking, or a host-exposed
    // UDP port) runs against Docker Desktop on Windows/WSL2. Default WSL2 NAT networking severely
    // throttles the high connection churn of P2P traffic; WSL2 mirrored networking fixes it. Core
    // cannot set that host-level mode itself, so the best it can do is make the requirement loud
    // instead of leaving the operator with a silently near-zero download. See host-networking.md.
    private void MaybeAdviseWslMirroredNetworking(RuntimeLifecycleContext context, IReadOnlyList<RuntimeSelectedService> services)
    {
        if (!IsLikelyDockerDesktopOnWindows())
        {
            return;
        }

        var peerToPeerShaped = services.Any(service =>
            service.Runtime.IsHostNetwork ||
            service.Runtime.Ports.Any(port =>
                string.Equals(port.Expose, "host", StringComparison.OrdinalIgnoreCase) &&
                port.Transport is { Count: > 0 } transports &&
                transports.Any(transport => string.Equals(transport, "udp", StringComparison.OrdinalIgnoreCase))));

        if (!peerToPeerShaped || !wslMirroredAdvised.TryAdd(context.App.Id, 0))
        {
            return;
        }

        logger.LogWarning(
            "App '{AppId}' uses host networking or a host-exposed UDP port for peer-to-peer traffic, and Core appears to be running " +
            "against Docker Desktop on Windows/WSL2. Default WSL2 NAT networking severely throttles peer-to-peer throughput. Enable WSL2 " +
            "mirrored networking: add 'networkingMode=mirrored' under [wsl2] in %UserProfile%\\.wslconfig, run 'wsl --shutdown', then restart " +
            "Docker Desktop. See docs/features/host-networking.md.",
            context.App.Id);
    }

    // Heuristic: are we talking to Docker Desktop's WSL2 backend? True when Core runs on Windows
    // (Docker Desktop is the only practical daemon there) or inside a WSL distro (the kernel
    // release string carries "microsoft"/"WSL"). Native Linux returns false — bridge/host
    // networking there is kernel-native and needs no advisory.
    private static bool IsLikelyDockerDesktopOnWindows()
    {
        if (OperatingSystem.IsWindows())
        {
            return true;
        }

        try
        {
            foreach (var path in WslKernelInfoPaths)
            {
                if (File.Exists(path) &&
                    File.ReadAllText(path) is var text &&
                    (text.Contains("microsoft", StringComparison.OrdinalIgnoreCase) ||
                        text.Contains("WSL", StringComparison.OrdinalIgnoreCase)))
                {
                    return true;
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Best-effort detection; if the kernel files are unreadable, skip the advisory.
        }

        return false;
    }

    // Builds the docker `run` arguments for a service's privileged extras: `--cap-add {CAP}` per
    // declared Linux capability (normalized to docker's prefixless uppercase form) and `--device
    // {path}` per declared host device. Empty when neither is declared, so the default launch is
    // byte-for-byte unchanged.
    internal static IReadOnlyList<string> BuildPrivilegedArguments(RuntimeServiceProfileManifest runtime)
    {
        var args = new List<string>();
        foreach (var capability in runtime.Capabilities)
        {
            args.Add("--cap-add");
            args.Add(LinuxCapabilities.Normalize(capability));
        }

        foreach (var device in runtime.Devices)
        {
            args.Add("--device");
            args.Add(device.Trim());
        }

        return args;
    }

    // Translates a service's "exec" healthcheck into docker run --health-* flags so the container gets
    // a HEALTHCHECK whose result the adapter reads back via State.Health.Status (Phase 0). type
    // none/absent (and the reserved http/tcp) emit nothing, leaving any image-baked HEALTHCHECK as-is.
    internal static IReadOnlyList<string> BuildHealthcheckArguments(RuntimeServiceProfileManifest runtime)
    {
        var healthcheck = runtime.Healthcheck;
        if (healthcheck is null ||
            !string.Equals(healthcheck.Type, "exec", StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(healthcheck.Command))
        {
            return [];
        }

        var args = new List<string> { "--health-cmd", healthcheck.Command };
        if (healthcheck.IntervalSeconds is int interval && interval > 0)
        {
            args.Add("--health-interval");
            args.Add($"{interval}s");
        }

        if (healthcheck.TimeoutSeconds is int timeout && timeout > 0)
        {
            args.Add("--health-timeout");
            args.Add($"{timeout}s");
        }

        if (healthcheck.Retries is int retries && retries > 0)
        {
            args.Add("--health-retries");
            args.Add(retries.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        if (healthcheck.GracePeriodSeconds is int grace && grace > 0)
        {
            args.Add("--health-start-period");
            args.Add($"{grace}s");
        }

        return args;
    }

    internal static IReadOnlyList<string> BuildDockerCoreEnvironment(HostyCoreRuntimeConfig config)
        => [
            $"HOSTY_CORE_PORT={config.CorePort.ToString(System.Globalization.CultureInfo.InvariantCulture)}",
            $"HOSTY_CORE_PUBLIC_ORIGIN={config.EffectiveCorePublicOrigin}",
            $"HOSTY_CORE_ORIGIN={BuildDockerCoreOrigin(config.EffectiveCorePublicOrigin)}",
        ];

    // OTEL_* `-e KEY=VALUE` run args for a docker service whose manifest opts into telemetry, when a
    // collector endpoint is available. The endpoint's loopback host is rewritten to host.docker.internal
    // (the same rewrite as HOSTY_CORE_ORIGIN) so the container reaches the host-published OTLP port —
    // the localCommand adapter, whose process runs on the host, uses the loopback endpoint unchanged.
    // Empty when telemetry is disabled or no endpoint resolved. No bearer token in v1: per-app ingest
    // auth is deferred (host-internal bind). See docs/features/observability.md.
    internal static IReadOnlyList<string> BuildTelemetryEnvironment(RuntimeLifecycleContext context, string serviceKey)
    {
        var settings = RuntimeTelemetrySettings.FromManifest(context.Manifest.Manifest.Telemetry);
        var endpoint = string.IsNullOrWhiteSpace(context.TelemetryEndpoint)
            ? null
            : BuildDockerCoreOrigin(context.TelemetryEndpoint);
        return settings.BuildEnvironment(endpoint, context.App.Id, serviceKey)
            .Select(pair => $"{pair.Key}={pair.Value}")
            .ToArray();
    }

    internal static string BuildDockerCoreOrigin(string coreOrigin)
    {
        if (!Uri.TryCreate(coreOrigin, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) ||
            !IsLoopbackHost(uri.Host))
        {
            return coreOrigin;
        }

        var builder = new UriBuilder(uri)
        {
            Host = "host.docker.internal",
            Path = string.Empty,
            Query = string.Empty,
            Fragment = string.Empty,
        };
        return builder.Uri.GetLeftPart(UriPartial.Authority);
    }

    private static string NormalizeDockerName(string value)
    {
        var normalized = new string(value.Select(character => char.IsLetterOrDigit(character) ? char.ToLowerInvariant(character) : '-').ToArray());
        return string.IsNullOrWhiteSpace(normalized) ? "app" : normalized.Trim('-');
    }

    private static bool IsLoopbackHost(string host)
    {
        if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return IPAddress.TryParse(host, out var address) && IPAddress.IsLoopback(address);
    }

}

internal sealed record RuntimeLifecycleContext(
    AppRecord App,
    RuntimeAppManifestSelection Manifest,
    string AppRoot,
    string AppDataPath,
    IReadOnlyDictionary<string, string> DependencyUrls,
    IReadOnlyList<RuntimeMount> Mounts,
    // The OTLP/HTTP origin of the telemetry collector (host.docker.internal:<port>-rewritable
    // loopback URL), or null when observability is off / the collector is not yet up. The docker
    // adapter injects OTEL_* env from this only for an app whose manifest opts into telemetry.
    string? TelemetryEndpoint = null,
    // The effective source root the lifecycle service resolved for this start, honoring the runtime's
    // Development Mode. Set for a locked (Dev Mode off) source runtime — the managed checkout pinned to
    // its commit — so execution ignores any live override. Null lets the localCommand adapter fall back
    // to its own resolution (override → managed checkout → app root), the live/default path.
    string? SourceRoot = null);

internal sealed record RuntimeAppManifestSelection(
    RuntimeAppManifest Manifest,
    string ManifestPath,
    string ManifestDigest,
    RuntimeProfileManifest RuntimeProfile,
    IReadOnlyList<RuntimeSelectedService> Services,
    RuntimeAppDataTarget? DataTarget,
    string ManifestJson,
    string? ManifestUrl);

internal sealed record RuntimeSelectedService(
    string Key,
    IReadOnlyList<RuntimeServiceDependency> DependsOn,
    RuntimeServiceProfileManifest Runtime,
    RuntimeDockerImage? Image,
    // Resolved artifact kind for the selected runtime (A1): "image" (compiled, lockable) or
    // "source" (live operator folder). Drives the update model and the liveness marker (R15).
    string Artifact);

// A `services[].dependsOn` entry. Accepts either a bare service-key string (`"api"`) or an
// object that names a specific port (`{ "service": "api", "port": "internal" }`). One
// declaration drives both startup ordering and intra-app URL discovery; see
// [RuntimeServiceDiscovery].
[JsonConverter(typeof(RuntimeServiceDependencyJsonConverter))]
internal sealed record RuntimeServiceDependency(string Service, string? Port);

// A docker image the manifest declares. The manifest only ever carries intent (`repository:tag`);
// the resolved immutable digest lives in the app-level lock (`AppRecord.ArtifactLocks`), not here.
// `Digest` is populated transiently by the docker adapter when it combines the manifest image with a
// resolved/locked digest to produce the pin (`repository@sha256:...`) that is actually run.
internal sealed record RuntimeDockerImage(string Repository, string Tag, string? Digest = null)
{
    // The reference to run: the pinned digest when one is set, else the mutable tag. Running the
    // digest is what makes restarts deterministic (see runtime-app-marketplace.md, "Start / restart").
    public string Reference => string.IsNullOrWhiteSpace(Digest)
        ? $"{Repository}:{Tag}"
        : $"{Repository}@{Digest}";

    // The mutable pointer (`repository:tag`), always tag-shaped. Used to (re-)resolve a digest at
    // install/update/rolling-start and to describe the manifest intent in update plans.
    public string TagReference => $"{Repository}:{Tag}";
}

internal sealed class RuntimeAppManifest
{
    // Collection properties coalesce null to empty in the getter so that members absent
    // from the JSON behave the same under the source generator (used for Native AOT) as
    // under the reflection serializer, which preserved the `= []` initializer.
    public string? SchemaVersion { get; init; }
    public string? Id { get; init; }
    public string? Name { get; init; }
    public string? Description { get; init; }
    public string? Version { get; init; }
    // Optional first-class app role. "system" marks a platform system app: install (and a reviewed
    // update) stores it as AppRecord.System, which gates app identity flows to host.admin and drives
    // client System grouping and lifecycle policy. Any other value fails validation, so a manifest
    // written for a newer role vocabulary cannot install as an ordinary runtime app by accident.
    public string? Role { get; init; }
    public RuntimeAppSource? Source { get; init; }
    public IReadOnlyList<RuntimeProfileManifest> RuntimeProfiles { get => field ?? []; init; } = [];
    public string? DefaultRuntime { get; init; }
    public IReadOnlyList<RuntimeAppServiceManifest> Services { get => field ?? []; init; } = [];
    public RuntimeAppDataManifest? Data { get; init; }
    public RuntimeAppUiManifest? Ui { get; init; }
    // Optional marketplace/catalog display metadata (publisher, tags, screenshots, license, links, …).
    // Deliberately kept OUT of app.0.1 runtime validation (see runtime-app-marketplace.md, B5): a
    // manifest without it is fully valid, and its content never fails runtime validation — it is
    // normalized best-effort by AppCatalogMetadataContract.FromManifest and surfaced for display only.
    // (It must still be deserializable JSON of the shape below; a type mismatch fails the whole manifest
    // parse like any other field. Strict content checks live in the catalog CI, not here.)
    public RuntimeAppCatalogMetadataManifest? CatalogMetadata { get; init; }
    public IReadOnlyList<RuntimeAppSettingManifest> Settings { get => field ?? []; init; } = [];
    public IReadOnlyList<RuntimeAppDependencyManifest> Dependencies { get => field ?? []; init; } = [];
    public IReadOnlyList<RuntimeAppEndpointManifest> Endpoints { get => field ?? []; init; } = [];
    public IReadOnlyList<string> Capabilities { get => field ?? []; init; } = [];
    public IReadOnlyDictionary<string, RuntimeAppExternalMountManifest> ExternalMounts { get => field ??= new Dictionary<string, RuntimeAppExternalMountManifest>(); init; } = new Dictionary<string, RuntimeAppExternalMountManifest>();
    public RuntimeAppRestartPolicyManifest? RestartPolicy { get; init; }
    public RuntimeAppTelemetryManifest? Telemetry { get; init; }
}

// Operator-configured external host-path mount slot. The manifest declares the slot
// (what the app can accept); the operator later binds concrete host paths to it. `mode`
// is authoritative for whether the bind is read-only — the operator only picks paths.
internal sealed record RuntimeAppExternalMountManifest
{
    public string Kind { get => field ?? "host-path"; init; } = "host-path";
    public bool Multiple { get; init; }
    public string Mode { get => field ?? "rw"; init; } = "rw";
    public string? Service { get; init; }
    public bool Required { get; init; }
}

// Declares how the supervisor restarts this app when it is observed to have crashed (all services
// exited) while Core still believed it was running. `mode`: "no" (default) never restarts;
// "on-failure" and "always" restart with exponential backoff up to `maxRetries` attempts before
// giving up. Additive under schemaVersion app.0.1; absent means no supervisor-driven restart.
internal sealed record RuntimeAppRestartPolicyManifest
{
    public string Mode { get => field ?? "no"; init; } = "no";
    public int? MaxRetries { get; init; }
    public int? BackoffSeconds { get; init; }
}

// Restart policy with manifest defaults applied, ready for the supervisor to act on. Mode "no"
// disables supervisor restarts; "on-failure"/"always" both restart an app observed to have crashed
// (the supervisor never sees operator-initiated stops). Default budget: 5 attempts, 10s base backoff.
internal sealed record RuntimeRestartPolicy(string Mode, int MaxRetries, int BackoffSeconds)
{
    public static readonly RuntimeRestartPolicy Disabled = new("no", 0, 0);

    public bool Enabled => !string.Equals(Mode, "no", StringComparison.Ordinal);

    public static RuntimeRestartPolicy FromManifest(RuntimeAppRestartPolicyManifest? manifest)
    {
        if (manifest is null)
        {
            return Disabled;
        }

        var mode = (manifest.Mode ?? "no").Trim().ToLowerInvariant() switch
        {
            "on-failure" => "on-failure",
            "always" => "always",
            _ => "no",
        };
        var maxRetries = manifest.MaxRetries is int retries && retries >= 0 ? retries : 5;
        var backoff = manifest.BackoffSeconds is int seconds && seconds >= 0 ? seconds : 10;
        return new RuntimeRestartPolicy(mode, maxRetries, backoff);
    }
}

// Declares whether this app exports OpenTelemetry to the Hosty collector and at what trace sample
// ratio. Opt-in: absent or enabled=false means no OTEL_* environment is injected (the app produces
// no OTLP). Additive under schemaVersion app.0.1. Both the docker and localCommand runtimes act on
// this (see observability.md), differing only in the collector endpoint host they inject (container
// host.docker.internal vs host loopback). sampleRatio applies to traces (head-based).
internal sealed record RuntimeAppTelemetryManifest
{
    public bool? Enabled { get; init; }
    public double? SampleRatio { get; init; }
}

// Telemetry intent with manifest defaults applied, ready for the docker adapter to act on. Disabled
// by default; SampleRatio is clamped to [0,1] with a 0.1 head-based default so an opted-in app that
// omits a ratio still samples a sane fraction of traces.
internal sealed record RuntimeTelemetrySettings(bool Enabled, double SampleRatio)
{
    public static readonly RuntimeTelemetrySettings Disabled = new(false, 0.1);

    public static RuntimeTelemetrySettings FromManifest(RuntimeAppTelemetryManifest? manifest)
    {
        if (manifest is null || manifest.Enabled != true)
        {
            return Disabled;
        }

        var ratio = manifest.SampleRatio is double value ? Math.Clamp(value, 0.0, 1.0) : 0.1;
        return new RuntimeTelemetrySettings(true, ratio);
    }

    // Standard OTEL_* environment for an opted-in app, given the collector endpoint already resolved for
    // the target runtime: the docker adapter passes a host.docker.internal-rewritten origin, the
    // localCommand adapter passes the host-loopback origin unchanged (its process runs on the host).
    // Empty when telemetry is disabled or no endpoint resolved — every OpenTelemetry SDK honours these
    // standard variables, so no app-specific wiring is required.
    public IReadOnlyList<KeyValuePair<string, string>> BuildEnvironment(string? endpoint, string appId, string serviceKey)
    {
        if (!Enabled || string.IsNullOrWhiteSpace(endpoint))
        {
            return [];
        }

        // Round-trippable invariant form: a fixed "0.###" would truncate small ratios (0.0001 -> "0",
        // silently disabling traces). The validated ratio is already in [0,1].
        var ratio = SampleRatio.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return
        [
            new("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint),
            new("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf"),
            new("OTEL_SERVICE_NAME", appId),
            new("OTEL_RESOURCE_ATTRIBUTES", $"service.name={appId},hosty.app.id={appId},hosty.app.service={serviceKey}"),
            new("OTEL_TRACES_SAMPLER", "parentbased_traceidratio"),
            new("OTEL_TRACES_SAMPLER_ARG", ratio),
        ];
    }
}

internal sealed record RuntimeAppSource(
    string? Type,
    string? Repository,
    string? Branch,
    string? Tag,
    string? Commit);

internal sealed class RuntimeProfileManifest
{
    public string Key { get => field ?? ""; init; } = "";
    public string Type { get => field ?? ""; init; } = "";
    public bool Default { get; init; }

    // Marks a runtime meant for local development. Two coupled consequences: the operator may point
    // it at their own source folder (source override), and it runs live from that folder (no lock, no
    // reviewed update — the "Live" affordance). Only valid for a source runtime (localCommand in v1);
    // at most one per manifest. A non-development source runtime is locked and updated in review, even
    // though it also runs from source. See docs/features/runtime-artifact-model.md.
    public bool Development { get; init; }
}

internal sealed class RuntimeAppServiceManifest
{
    public string Key { get => field ?? ""; init; } = "";
    public IReadOnlyList<RuntimeServiceDependency> DependsOn { get => field ?? []; init; } = [];
    public IReadOnlyDictionary<string, RuntimeServiceProfileManifest> Runtimes { get => field ??= new Dictionary<string, RuntimeServiceProfileManifest>(); init; } = new Dictionary<string, RuntimeServiceProfileManifest>();
}

// Delivery descriptor for a `prebuilt` artifact — where the already-compiled build is fetched from.
// v1 supports `folder` only: `Path` is a directory holding the build, resolved relative to the app's
// source root (or absolute). `git-release`/`url` are reserved. See runtime-artifact-model.md.
internal sealed record RuntimePrebuiltDeliveryManifest
{
    public string? Type { get; init; }
    public string? Path { get; init; }
}

// Per-service health probe applied by the runtime (Phase 1c). v1 supports type "exec": the docker
// runtime translates it to a container HEALTHCHECK (docker --health-*), whose result the adapter
// already reads back as State.Health.Status (Phase 0). type "none"/absent applies no Hosty-managed
// healthcheck and leaves any image-baked HEALTHCHECK untouched. http/tcp are reserved for upcoming
// Core-side probing. Additive under schemaVersion app.0.1.
internal sealed record RuntimeServiceHealthcheckManifest
{
    public string Type { get => field ?? "none"; init; } = "none";
    // For type "exec" (docker): the shell command docker runs in-container as --health-cmd (exit 0 = healthy).
    public string? Command { get; init; }
    // For type "http"/"tcp" (localCommand, Core-side probe): the declared container port to probe.
    // Omitted -> the service's first declared port. http additionally uses Path (default "/").
    public int? Port { get; init; }
    public string? Path { get; init; }
    public int? IntervalSeconds { get; init; }
    public int? TimeoutSeconds { get; init; }
    public int? Retries { get; init; }
    public int? GracePeriodSeconds { get; init; }
}

internal sealed record RuntimeServiceProfileManifest
{
    public string? Type { get; init; }

    // How the running code is delivered for this runtime (A1). `image` is a compiled, lockable
    // OCI artifact (pinned/rolling, digest in ArtifactLocks); `source` runs live from the operator's
    // own folder (no run-lock, manifest reconciled each start); `prebuilt` is a compiled non-container
    // build (localCommand only) delivered via `delivery`, content-hash-locked in ArtifactLocks and
    // materialized under the app's artifact store. Absent infers per runtime type — docker → `image`,
    // localCommand → `source`. See docs/features/runtime-artifact-model.md. The resolved kind is
    // re-derived from the manifest at start, never persisted on AppRecord.
    public string? Artifact { get; init; }

    // Where a `prebuilt` artifact's compiled build comes from. Required when artifact is `prebuilt`,
    // rejected otherwise. v1 supports `{ "type": "folder", "path": … }`; git-release/url are reserved.
    public RuntimePrebuiltDeliveryManifest? Delivery { get; init; }

    public JsonElement? Image { get; init; }

    // One-shot preparation command run to completion before `command` on every start (localCommand
    // only). It runs in the same `workingDirectory` with the same environment as `command`; a
    // non-zero exit fails the start. This is where a source-run app installs dependencies or builds
    // (`npm install`, `dotnet restore`, `pip install`, …) — the checkout Core pulls has no
    // `node_modules`/artifacts, so without it a fresh dev checkout can't start. Empty by default.
    public string? Setup { get; init; }

    public string? Command { get; init; }
    public string? WorkingDirectory { get; init; }
    public IReadOnlyDictionary<string, string> Environment { get => field ??= new Dictionary<string, string>(); init; } = new Dictionary<string, string>();
    public IReadOnlyList<RuntimePortManifest> Ports { get => field ?? []; init; } = [];

    // Per-service health probe for this runtime (Phase 1c). See RuntimeServiceHealthcheckManifest.
    public RuntimeServiceHealthcheckManifest? Healthcheck { get; init; }

    // Docker network mode (docker runtime only; off by default). null/"bridge" keeps the current
    // behaviour (per-app user network for service discovery, else the default bridge). "host" runs
    // the container with `--network host` so its listeners bind the host's interfaces directly —
    // no NAT, no `-p` publishing — which is the right fit for high-churn peer-to-peer traffic
    // (e.g. BitTorrent) where the docker bridge NAT collapses throughput. See host-networking.md.
    public string? Network { get; init; }

    // Convenience predicate used by validation and the docker adapter. Not serialized — it is a
    // derived view of Network, and emitting it would pollute the round-tripped manifest JSON.
    [JsonIgnore]
    public bool IsHostNetwork => string.Equals(Network, "host", StringComparison.OrdinalIgnoreCase);

    // Linux capabilities to grant the container (`--cap-add`; docker runtime only; empty by
    // default). Privileged: surfaced for install review like a host-exposed port. The canonical
    // use is NET_ADMIN for an in-container VPN. See container-capabilities.md.
    public IReadOnlyList<string> Capabilities { get => field ?? []; init; } = [];

    // Host device nodes to expose to the container (`--device`; docker runtime only; empty by
    // default). Each must be an absolute path under /dev (host path == container path). The
    // canonical use is /dev/net/tun for a VPN tunnel. See container-capabilities.md.
    public IReadOnlyList<string> Devices { get => field ?? []; init; } = [];
}

// The canonical Linux capability vocabulary, used to validate `capabilities` (typo protection) and
// to normalize a declared name to docker's `--cap-add` form. Names are stored without the optional
// `CAP_` prefix, uppercased; both `NET_ADMIN` and `CAP_NET_ADMIN` normalize to `NET_ADMIN`.
internal static class LinuxCapabilities
{
    private static readonly HashSet<string> Canonical = new(StringComparer.Ordinal)
    {
        "CHOWN", "DAC_OVERRIDE", "DAC_READ_SEARCH", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID",
        "SETPCAP", "LINUX_IMMUTABLE", "NET_BIND_SERVICE", "NET_BROADCAST", "NET_ADMIN", "NET_RAW",
        "IPC_LOCK", "IPC_OWNER", "SYS_MODULE", "SYS_RAWIO", "SYS_CHROOT", "SYS_PTRACE", "SYS_PACCT",
        "SYS_ADMIN", "SYS_BOOT", "SYS_NICE", "SYS_RESOURCE", "SYS_TIME", "SYS_TTY_CONFIG", "MKNOD",
        "LEASE", "AUDIT_WRITE", "AUDIT_CONTROL", "SETFCAP", "MAC_OVERRIDE", "MAC_ADMIN", "SYSLOG",
        "WAKE_ALARM", "BLOCK_SUSPEND", "AUDIT_READ", "PERFMON", "BPF", "CHECKPOINT_RESTORE",
    };

    public static string Normalize(string capability)
    {
        var trimmed = capability.Trim().ToUpperInvariant();
        return trimmed.StartsWith("CAP_", StringComparison.Ordinal) ? trimmed[4..] : trimmed;
    }

    public static bool IsKnown(string capability) => Canonical.Contains(Normalize(capability));
}

internal sealed class RuntimePortManifest
{
    public string? Key { get; init; }
    public int? ContainerPort { get; init; }
    public int? LocalPort { get; init; }
    public int? HostPort { get; init; }
    public string? Protocol { get; init; }
    public bool? Public { get; init; }

    // Opt-in raw L4 publishing (docker runtime only; off by default). `Expose` null/"loopback"
    // keeps the default 127.0.0.1 bind; "host" binds 0.0.0.0 so the port is reachable off-host.
    // `Transport` is left nullable (not coalesced to []) so validation can tell an absent field
    // from an explicit empty list; null/absent means the legacy TCP-only publish.
    public string? Expose { get; init; }
    public IReadOnlyList<string>? Transport { get; init; }
}

internal sealed class RuntimeAppDataManifest
{
    public bool Enabled { get; init; }
    public IReadOnlyList<RuntimeAppDataTarget> Targets { get => field ?? []; init; } = [];
}

internal sealed class RuntimeAppDataTarget
{
    public string? Runtime { get; init; }
    public string? Service { get; init; }
    public string? ContainerPath { get; init; }
    public string? Environment { get; init; }
}

internal sealed class RuntimeAppUiManifest
{
    public string? Category { get; init; }
    public string? Icon { get; init; }
    public JsonElement? Entrypoint { get; init; }
    public string? Path { get; init; }
    public string? PortKey { get; init; }
    public IReadOnlyList<RuntimeAppUiNavigationItemManifest> Navigation { get => field ?? []; init; } = [];
}

internal sealed class RuntimeAppUiNavigationItemManifest
{
    public string? Label { get; init; }
    public string? Path { get; init; }
    public string? Endpoint { get; init; }
    public string? PortKey { get; init; }
    // Optional manifest-relative image for this page's sidebar link (manifest-level app assets),
    // served through the per-app asset endpoint. Clients fall back to a Lucide icon. Display-only.
    public string? IconAsset { get; init; }
}

// Marketplace/catalog display metadata (fields modeled on Flathub AppStream). Optional and outside
// runtime validation: the manifest author owns it as the display source of truth (see
// runtime-app-marketplace.md, Q5). `Category` here is the marketplace category; the simpler
// `ui.category` remains for the existing app-directory display. Strict shape checks (SPDX, enum
// category) live in the catalog CI schema, not in Core's lean runtime validation.
internal sealed class RuntimeAppCatalogMetadataManifest
{
    public RuntimeAppPublisherManifest? Publisher { get; init; }
    public string? Category { get; init; }
    public IReadOnlyList<string> Tags { get => field ?? []; init; } = [];
    // Icon as an asset path or URL (richer than ui.icon, which is a Lucide name).
    public string? Icon { get; init; }
    public IReadOnlyList<string> Screenshots { get => field ?? []; init; } = [];
    // SPDX license identifier (e.g. "AGPL-3.0-only"). Free-form here; not validated at runtime.
    public string? License { get; init; }
    public RuntimeAppCatalogLinksManifest? Links { get; init; }
    public string? Summary { get; init; }
    public string? Description { get; init; }
    // Manifest-relative path to a markdown long-description (e.g. "docs/store.md"). Served through the
    // per-app asset endpoint; the app repo owns it. Display-only, outside runtime validation.
    public string? DescriptionFile { get; init; }
    public string? Changelog { get; init; }
}

internal sealed class RuntimeAppPublisherManifest
{
    public string? Name { get; init; }
    public string? Url { get; init; }
    public string? Email { get; init; }
}

internal sealed class RuntimeAppCatalogLinksManifest
{
    public string? Website { get; init; }
    public string? Docs { get; init; }
    public string? Support { get; init; }
}

internal sealed class RuntimeAppSettingManifest
{
    public string Key { get => field ?? ""; init; } = "";
    public string Type { get => field ?? "string"; init; } = "string";
    public string? Default { get; init; }
    public bool Secret { get; init; }
    public bool Required { get; init; }

    // Optional human-readable metadata surfaced by the Shell settings/install UI. Label is a friendly
    // name shown instead of the raw env-var Key; Description is help text explaining what the setting
    // does. Both are presentation-only — Core never validates or acts on them.
    public string? Label { get; init; }
    public string? Description { get; init; }
}

internal sealed class RuntimeAppDependencyManifest
{
    public string Id { get => field ?? ""; init; } = "";
    public string? Version { get; init; }

    // Whether the dependency must be present: drives the level of the start-time advisory when it is
    // missing/not running (error vs warning). Absent defaults to true (see RequiredOrDefault) — a
    // plain bool initializer does not survive source-gen deserialization. Hosty does not
    // auto-install/auto-start a dependency, it only notifies; see cross-app-dependencies.md.
    public bool? Required { get; init; }

    [JsonIgnore]
    public bool RequiredOrDefault => Required ?? true;

    // Which of the dependency app's endpoints to wire into this app, and under which env alias each
    // is injected (`HOSTY_DEPENDENCY_{ALIAS}_URL`). Empty = lifecycle awareness only, no URL.
    public IReadOnlyList<RuntimeAppDependencyEndpoint> Endpoints { get => field ?? []; init; } = [];
}

// One wired endpoint of a cross-app dependency. `Key` is the endpoint key as declared in the
// dependency app's manifest; `As` is the env alias for the injected URL (defaults to `Key`).
internal sealed record RuntimeAppDependencyEndpoint(string Key, string? As)
{
    [JsonIgnore]
    public string Alias => string.IsNullOrWhiteSpace(As) ? Key : As;
}

internal sealed class RuntimeAppEndpointManifest
{
    public string Key { get => field ?? ""; init; } = "";
    public string? Service { get; init; }
    public string? Port { get; init; }
    public string? Protocol { get; init; }
    public bool Public { get; init; }
}

// Per-service artifact locks the runtime resolved during start (compiled artifacts only). Null when
// the runtime has nothing to pin (e.g. localCommand/source), in which case the caller leaves any
// existing locks untouched. The lifecycle service persists these onto AppRecord.ArtifactLocks.
internal sealed record AppRuntimeStartResult(
    string RuntimeState,
    IReadOnlyList<AppEndpointContract> Endpoints,
    IReadOnlyDictionary<string, ArtifactLock>? ArtifactLocks = null);

internal sealed record AppRuntimeOperationResult(string RuntimeState);

internal sealed record AppRuntimeLogsResult(string Text, IReadOnlyList<AppRuntimeServiceLogs>? Services = null);

internal sealed record AppRuntimeServiceLogs(string Service, string Text);

internal sealed record AppRuntimeHealthResult(string Status, IReadOnlyList<AppRuntimeServiceHealth> Services);

internal sealed record AppRuntimeServiceHealth(
    string Service,
    string Status,
    int? ProcessId,
    int? ExitCode,
    string? LogPath,
    string? WorkingDirectory,
    string? Message,
    // The image the service is actually running, reported by the docker runtime as
    // `repository@sha256:...` (its first repo digest). Lets clients surface "running != lock" drift.
    // Null for runtimes that have no image (localCommand) or when it cannot be determined.
    string? Image = null,
    // Container HEALTHCHECK result ("healthy"/"unhealthy"/"starting"), or null when the runtime has
    // no health probe (localCommand) or the image declares no HEALTHCHECK. Distinct from Status,
    // which stays a pure liveness signal so existing callers keying off "running" are unaffected.
    string? Health = null,
    // Times the runtime has restarted this service (docker RestartCount), or null when unavailable.
    int? RestartCount = null,
    // RFC3339 start timestamp of the current run as reported by the runtime, or null when not started.
    string? StartedAt = null);

internal sealed record AppManifestValidationError(string Code, string Message, string Path);

internal sealed class AppManifestException : Exception
{
    public AppManifestException(string code, string message)
        : base(message)
    {
        Code = code;
        Errors = [];
    }

    public AppManifestException(string code, string message, IReadOnlyList<AppManifestValidationError> errors)
        : base(message)
    {
        Code = code;
        Errors = errors;
    }

    public string Code { get; }

    public IReadOnlyList<AppManifestValidationError> Errors { get; }
}

internal sealed class AppLifecycleException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
