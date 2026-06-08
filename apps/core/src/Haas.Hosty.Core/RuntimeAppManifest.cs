using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

internal sealed class AppManifestService(HttpClient? httpClient = null)
{
    private const string SupportedSchemaVersion = "app.0.1";
    private const int MaxManifestBytes = 1024 * 1024;
    private static readonly Regex ContractKeyPattern = new("^[a-z][a-z0-9-]{0,62}$", RegexOptions.Compiled);
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
            manifest = JsonSerializer.Deserialize<RuntimeAppManifest>(source.Json, JsonOptions);
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
            errors.Add(new("app_manifest_id_invalid", "App id must contain only letters, numbers, '.', '_' or '-'.", "$.id"));
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

            selectedServices.Add(new RuntimeSelectedService(service.Key, service.DependsOn, runtime with { Type = runtimeType }, image));
        }

        if (selectedProfile is not null && selectedServices.Count == 0)
        {
            errors.Add(new("app_manifest_selected_services_missing", "The selected runtime does not produce any runnable services.", "$.services"));
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
            ManifestJson: manifestJson ?? JsonSerializer.Serialize(manifest, JsonOptions),
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
        if (!File.Exists(fullPath))
        {
            throw new AppManifestException("manifest_not_found", $"Runtime app manifest was not found at '{fullPath}'.");
        }

        return new AppManifestSource(fullPath, await File.ReadAllTextAsync(fullPath, cancellationToken), ManifestUrl: null);
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
        => value.All(character => char.IsLetterOrDigit(character) || character is '.' or '_' or '-');

    private static void ValidateRequired(string? value, string path, List<AppManifestValidationError> errors)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            errors.Add(new("app_manifest_required_field_missing", $"{path} is required.", path));
        }
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
    };
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
    AppServiceTokenService serviceTokens) : IAppRuntimeAdapter
{
    public string Type => "docker";

    public async Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
    {
        var endpoints = new List<AppEndpointContract>();
        var services = OrderServices(context.Manifest.Services);

        foreach (var service in services)
        {
            if (service.Image is null)
            {
                throw new AppLifecycleException("runtime_profile_invalid", $"Docker service '{service.Key}' does not declare an image.");
            }

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
                "--label",
                $"hosty.app.id={context.App.Id}",
                "--label",
                $"hosty.app.service={service.Key}",
                "-e",
                $"HOSTY_APP_ID={context.App.Id}",
                "-e",
                $"HOSTY_APP_SERVICE_KEY={service.Key}",
                "-e",
                $"HOSTY_CORE_ORIGIN={config.CorePublicOrigin ?? config.ListenUrl}",
            };

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
                runArgs.Add($"HOSTY_DEPENDENCY_{NormalizeEnvironmentKey(dependency.Key)}_URL={dependency.Value}");
            }

            var assignedPorts = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var port in service.Runtime.Ports)
            {
                if (port.ContainerPort is null)
                {
                    continue;
                }

                var hostPort = port.LocalPort ?? port.HostPort ?? AllocateLoopbackPort();
                assignedPorts[port.Key ?? port.ContainerPort.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)] = hostPort;
                runArgs.Add("-p");
                runArgs.Add($"127.0.0.1:{hostPort}:{port.ContainerPort.Value}");
                if (!string.IsNullOrWhiteSpace(port.Key))
                {
                    runArgs.Add("-e");
                    runArgs.Add($"HOSTY_PORT_{NormalizeEnvironmentKey(port.Key)}={hostPort}");
                }
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

        return new AppRuntimeOperationResult("removed");
    }

    public async Task<AppRuntimeLogsResult> GetLogsAsync(RuntimeLifecycleContext context, int tail, CancellationToken cancellationToken = default)
    {
        var lines = new List<string>();
        foreach (var service in context.Manifest.Services)
        {
            var output = await RunDockerAsync(
                ["logs", "--tail", Math.Clamp(tail, 1, 1000).ToString(System.Globalization.CultureInfo.InvariantCulture), BuildContainerName(context.App.Id, service.Key)],
                ignoreFailures: true,
                cancellationToken);
            if (!string.IsNullOrWhiteSpace(output))
            {
                lines.Add($"== {service.Key} ==");
                lines.Add(output.TrimEnd());
            }
        }

        return new AppRuntimeLogsResult(string.Join(Environment.NewLine, lines));
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
                .Where(service => service.DependsOn.All(dependency => !remaining.ContainsKey(dependency)))
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

    private static string NormalizeDockerName(string value)
    {
        var normalized = new string(value.Select(character => char.IsLetterOrDigit(character) ? char.ToLowerInvariant(character) : '-').ToArray());
        return string.IsNullOrWhiteSpace(normalized) ? "app" : normalized.Trim('-');
    }

    private static string NormalizeEnvironmentKey(string value)
        => new(value.Select(character => char.IsLetterOrDigit(character) ? char.ToUpperInvariant(character) : '_').ToArray());

    private static int AllocateLoopbackPort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}

internal sealed record RuntimeLifecycleContext(
    AppRecord App,
    RuntimeAppManifestSelection Manifest,
    string AppRoot,
    string AppDataPath,
    IReadOnlyDictionary<string, string> DependencyUrls);

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
    IReadOnlyList<string> DependsOn,
    RuntimeServiceProfileManifest Runtime,
    RuntimeDockerImage? Image);

internal sealed record RuntimeDockerImage(string Repository, string Tag, string? PullPolicy)
{
    public string Reference => $"{Repository}:{Tag}";
}

internal sealed class RuntimeAppManifest
{
    public string? SchemaVersion { get; init; }
    public string? Id { get; init; }
    public string? Name { get; init; }
    public string? Description { get; init; }
    public string? Version { get; init; }
    public RuntimeAppSource? Source { get; init; }
    public string? ChannelsUrl { get; init; }
    public IReadOnlyList<RuntimeProfileManifest> RuntimeProfiles { get; init; } = [];
    public string? DefaultRuntime { get; init; }
    public IReadOnlyList<RuntimeAppServiceManifest> Services { get; init; } = [];
    public RuntimeAppDataManifest? Data { get; init; }
    public RuntimeAppUiManifest? Ui { get; init; }
    public IReadOnlyList<RuntimeAppSettingManifest> Settings { get; init; } = [];
    public IReadOnlyList<RuntimeAppDependencyManifest> Dependencies { get; init; } = [];
    public IReadOnlyList<RuntimeAppEndpointManifest> Endpoints { get; init; } = [];
    public IReadOnlyList<string> Capabilities { get; init; } = [];
}

internal sealed record RuntimeAppSource(
    string? Type,
    string? Repository,
    string? Branch,
    string? Tag,
    string? Commit);

internal sealed class RuntimeProfileManifest
{
    public string Key { get; init; } = "";
    public string Type { get; init; } = "";
    public bool Default { get; init; }
}

internal sealed class RuntimeAppServiceManifest
{
    public string Key { get; init; } = "";
    public IReadOnlyList<string> DependsOn { get; init; } = [];
    public IReadOnlyDictionary<string, RuntimeServiceProfileManifest> Runtimes { get; init; } = new Dictionary<string, RuntimeServiceProfileManifest>();
}

internal sealed record RuntimeServiceProfileManifest
{
    public string? Type { get; init; }
    public JsonElement? Image { get; init; }
    public string? Command { get; init; }
    public string? WorkingDirectory { get; init; }
    public IReadOnlyDictionary<string, string> Environment { get; init; } = new Dictionary<string, string>();
    public IReadOnlyList<RuntimePortManifest> Ports { get; init; } = [];
}

internal sealed class RuntimePortManifest
{
    public string? Key { get; init; }
    public int? ContainerPort { get; init; }
    public int? LocalPort { get; init; }
    public int? HostPort { get; init; }
    public string? Protocol { get; init; }
    public bool? Public { get; init; }
}

internal sealed class RuntimeAppDataManifest
{
    public bool Enabled { get; init; }
    public IReadOnlyList<RuntimeAppDataTarget> Targets { get; init; } = [];
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
    public IReadOnlyList<RuntimeAppUiNavigationItemManifest> Navigation { get; init; } = [];
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
    public string Key { get; init; } = "";
    public string Type { get; init; } = "string";
    public string? Default { get; init; }
    public bool Secret { get; init; }
}

internal sealed class RuntimeAppDependencyManifest
{
    public string Id { get; init; } = "";
    public string? Version { get; init; }
    public bool Required { get; init; }
}

internal sealed class RuntimeAppEndpointManifest
{
    public string Key { get; init; } = "";
    public string? Service { get; init; }
    public string? Port { get; init; }
    public string? Protocol { get; init; }
    public bool Public { get; init; }
}

internal sealed record AppRuntimeStartResult(string RuntimeState, IReadOnlyList<AppEndpointContract> Endpoints);

internal sealed record AppRuntimeOperationResult(string RuntimeState);

internal sealed record AppRuntimeLogsResult(string Text);

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
