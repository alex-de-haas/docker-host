using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

internal sealed class AppManifestService(HttpClient? httpClient = null, bool allowRemoteLocalCommand = false)
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

        await File.WriteAllTextAsync(targetPath, selection.ManifestJson, Encoding.UTF8, cancellationToken);
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

            if (profile.Default)
            {
                defaultProfileCount++;
            }
        }

        if (defaultProfileCount > 1)
        {
            errors.Add(new("app_manifest_runtime_default_duplicate", "Only one runtime profile may set default: true.", "$.runtimeProfiles"));
        }

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

        if (selectedProfile is { Type: "localCommand" } &&
            !string.IsNullOrWhiteSpace(manifestUrl) &&
            !allowRemoteLocalCommand)
        {
            errors.Add(new(
                "app_manifest_remote_local_command_blocked",
                "Remotely fetched manifests cannot select a localCommand runtime because it runs arbitrary commands on the host. Install from a reviewed local manifest path, or set HOSTY_ALLOW_REMOTE_LOCAL_COMMAND=1 to opt in.",
                "$.runtimeProfiles[].type"));
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

            ValidateNetwork(service.Key, runtimeType, runtime.Network, errors);
            ValidateCapabilities(service.Key, runtimeType, runtime.Capabilities, errors);
            ValidateDevices(service.Key, runtimeType, runtime.Devices, errors);
            ValidatePorts(service.Key, runtime.Ports, runtime.IsHostNetwork, errors);

            selectedServices.Add(new RuntimeSelectedService(service.Key, service.DependsOn, runtime with { Type = runtimeType }, image));
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
            return new RuntimeDockerImage(split.Repository, split.Tag, null);
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

        return new RuntimeDockerImage(repository, tag, ReadString(value.Value, "pullPolicy"));
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

    private static void ValidateRequired(string? value, string path, List<AppManifestValidationError> errors)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            errors.Add(new("app_manifest_required_field_missing", $"{path} is required.", path));
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

internal sealed class DockerRuntimeAdapter(
    HostyCoreRuntimeConfig config,
    AppServiceTokenService serviceTokens,
    ILogger<DockerRuntimeAdapter> logger) : IAppRuntimeAdapter
{
    // App ids already advised about WSL2 P2P throttling, so the warning is logged once per app
    // per Core process rather than on every (health-driven) restart. Instance field on the DI
    // singleton: its lifetime is the process, and it is bounded by the number of distinct apps
    // ever started (small), so it does not need explicit eviction.
    private readonly ConcurrentDictionary<string, byte> wslMirroredAdvised = new(StringComparer.Ordinal);

    // Kernel info files whose contents mark a WSL2 environment; allocated once, not per check.
    private static readonly string[] WslKernelInfoPaths = ["/proc/sys/kernel/osrelease", "/proc/version"];

    public string Type => "docker";

    public async Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
    {
        var endpoints = new List<AppEndpointContract>();
        var services = OrderServices(context.Manifest.Services);

        MaybeAdviseWslMirroredNetworking(context, services);

        // Siblings that `dependsOn` one another reach each other by service-name DNS over a
        // per-app user network, so the internal port never needs host publishing. Containers
        // run standalone otherwise, so only create the network when discovery is actually used.
        var dependencyNetwork = RequiresUserNetwork(services) ? BuildNetworkName(context.App.Id) : null;
        if (dependencyNetwork is not null)
        {
            _ = await RunDockerAsync(["network", "create", dependencyNetwork], ignoreFailures: true, cancellationToken);
        }

        foreach (var service in services)
        {
            if (service.Image is null)
            {
                throw new AppLifecycleException("runtime_profile_invalid", $"Docker service '{service.Key}' does not declare an image.");
            }

            var hostNetwork = service.Runtime.IsHostNetwork;
            var containerName = BuildContainerName(context.App.Id, service.Key);
            _ = await RunDockerAsync(["rm", "-f", containerName], ignoreFailures: true, cancellationToken);
            if (string.Equals(service.Image.PullPolicy, "always", StringComparison.OrdinalIgnoreCase))
            {
                _ = await RunDockerAsync(["pull", service.Image.Reference], ignoreFailures: false, cancellationToken);
            }

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
                    runArgs.Add($"{setting.Key}={setting.Value}");
                }
            }

            foreach (var environment in service.Runtime.Environment)
            {
                runArgs.Add("-e");
                runArgs.Add($"{environment.Key}={environment.Value}");
            }

            runArgs.Add("-e");
            runArgs.Add($"HOSTY_APP_SERVICE_TOKEN={serviceTokens.CreateToken(context.App.Id)}");

            foreach (var dependency in context.DependencyUrls)
            {
                runArgs.Add("-e");
                runArgs.Add($"HOSTY_DEPENDENCY_{RuntimePortHelper.NormalizeEnvironmentKey(dependency.Key)}_URL={dependency.Value}");
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

            runArgs.Add(service.Image.Reference);
            _ = await RunDockerAsync(runArgs, ignoreFailures: false, cancellationToken);

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

        return new AppRuntimeStartResult("running", endpoints);
    }

    public async Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
    {
        foreach (var service in context.Manifest.Services)
        {
            _ = await RunDockerAsync(["stop", BuildContainerName(context.App.Id, service.Key)], ignoreFailures: true, cancellationToken);
        }

        return new AppRuntimeOperationResult("stopped");
    }

    public async Task<AppRuntimeOperationResult> RemoveAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
    {
        foreach (var service in context.Manifest.Services)
        {
            _ = await RunDockerAsync(["rm", "-f", BuildContainerName(context.App.Id, service.Key)], ignoreFailures: true, cancellationToken);
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

    public Task<AppRuntimeHealthResult> GetHealthAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        => Task.FromResult(new AppRuntimeHealthResult(
            "unknown",
            context.Manifest.Services
                .Select(service => new AppRuntimeServiceHealth(
                    Service: service.Key,
                    Status: "unknown",
                    ProcessId: null,
                    ExitCode: null,
                    LogPath: null,
                    WorkingDirectory: null,
                    Message: "Docker runtime health inspection is not implemented."))
                .ToArray()));

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

    private static async Task<string> RunDockerAsync(IReadOnlyList<string> args, bool ignoreFailures, CancellationToken cancellationToken)
    {
        var process = new System.Diagnostics.Process
        {
            StartInfo = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "docker",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            },
        };
        foreach (var arg in args)
        {
            process.StartInfo.ArgumentList.Add(arg);
        }

        try
        {
            process.Start();
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            if (ignoreFailures)
            {
                return string.Empty;
            }

            throw new AppLifecycleException("docker_unavailable", $"Docker CLI is not available: {ex.Message}");
        }

        var stdout = await process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderr = await process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken);
        if (process.ExitCode != 0 && !ignoreFailures)
        {
            throw new AppLifecycleException("docker_operation_failed", string.IsNullOrWhiteSpace(stderr) ? $"Docker exited with code {process.ExitCode}." : stderr.Trim());
        }

        return stdout;
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

    internal static IReadOnlyList<string> BuildDockerCoreEnvironment(HostyCoreRuntimeConfig config)
        => [
            $"HOSTY_CORE_PORT={config.CorePort.ToString(System.Globalization.CultureInfo.InvariantCulture)}",
            $"HOSTY_CORE_PUBLIC_ORIGIN={config.EffectiveCorePublicOrigin}",
            $"HOSTY_CORE_ORIGIN={BuildDockerCoreOrigin(config.EffectiveCorePublicOrigin)}",
        ];

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
    IReadOnlyList<RuntimeMount> Mounts);

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
    RuntimeDockerImage? Image);

// A `services[].dependsOn` entry. Accepts either a bare service-key string (`"api"`) or an
// object that names a specific port (`{ "service": "api", "port": "internal" }`). One
// declaration drives both startup ordering and intra-app URL discovery; see
// [RuntimeServiceDiscovery].
[JsonConverter(typeof(RuntimeServiceDependencyJsonConverter))]
internal sealed record RuntimeServiceDependency(string Service, string? Port);

internal sealed record RuntimeDockerImage(string Repository, string Tag, string? PullPolicy)
{
    public string Reference => $"{Repository}:{Tag}";
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
    public RuntimeAppSource? Source { get; init; }
    public string? ChannelsUrl { get; init; }
    public IReadOnlyList<RuntimeProfileManifest> RuntimeProfiles { get => field ?? []; init; } = [];
    public string? DefaultRuntime { get; init; }
    public IReadOnlyList<RuntimeAppServiceManifest> Services { get => field ?? []; init; } = [];
    public RuntimeAppDataManifest? Data { get; init; }
    public RuntimeAppUiManifest? Ui { get; init; }
    public IReadOnlyList<RuntimeAppSettingManifest> Settings { get => field ?? []; init; } = [];
    public IReadOnlyList<RuntimeAppDependencyManifest> Dependencies { get => field ?? []; init; } = [];
    public IReadOnlyList<RuntimeAppEndpointManifest> Endpoints { get => field ?? []; init; } = [];
    public IReadOnlyList<string> Capabilities { get => field ?? []; init; } = [];
    public IReadOnlyDictionary<string, RuntimeAppExternalMountManifest> ExternalMounts { get => field ??= new Dictionary<string, RuntimeAppExternalMountManifest>(); init; } = new Dictionary<string, RuntimeAppExternalMountManifest>();
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
}

internal sealed class RuntimeAppServiceManifest
{
    public string Key { get => field ?? ""; init; } = "";
    public IReadOnlyList<RuntimeServiceDependency> DependsOn { get => field ?? []; init; } = [];
    public IReadOnlyDictionary<string, RuntimeServiceProfileManifest> Runtimes { get => field ??= new Dictionary<string, RuntimeServiceProfileManifest>(); init; } = new Dictionary<string, RuntimeServiceProfileManifest>();
}

internal sealed record RuntimeServiceProfileManifest
{
    public string? Type { get; init; }
    public JsonElement? Image { get; init; }
    public string? Command { get; init; }
    public string? WorkingDirectory { get; init; }
    public IReadOnlyDictionary<string, string> Environment { get => field ??= new Dictionary<string, string>(); init; } = new Dictionary<string, string>();
    public IReadOnlyList<RuntimePortManifest> Ports { get => field ?? []; init; } = [];

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
}

internal sealed class RuntimeAppSettingManifest
{
    public string Key { get => field ?? ""; init; } = "";
    public string Type { get => field ?? "string"; init; } = "string";
    public string? Default { get; init; }
    public bool Secret { get; init; }
    public bool Required { get; init; }
}

internal sealed class RuntimeAppDependencyManifest
{
    public string Id { get => field ?? ""; init; } = "";
    public string? Version { get; init; }
    public bool Required { get; init; }
}

internal sealed class RuntimeAppEndpointManifest
{
    public string Key { get => field ?? ""; init; } = "";
    public string? Service { get; init; }
    public string? Port { get; init; }
    public string? Protocol { get; init; }
    public bool Public { get; init; }
}

internal sealed record AppRuntimeStartResult(string RuntimeState, IReadOnlyList<AppEndpointContract> Endpoints);

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
    string? Message);

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
