namespace Haas.DockerHost.Cli.Commands;

using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;

internal enum DevHostMode
{
    DockerContainer,
    LocalProcess,
    External,
}

internal sealed record DevManifest
{
    private const string DefaultAdminPassword = "docker-host-dev-admin";
    private const string DefaultUserPassword = "docker-host-dev-user";
    private const int DefaultLocalHostPort = 3000;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    public string? MetadataUrl { get; init; }

    public string? MetadataFile { get; init; }

    public string? MetadataFileHost { get; init; }

    public string? ModuleCommand { get; init; }

    public string? WorkingDirectory { get; init; }

    public DevManifestHost Host { get; init; } = new();

    public DevManifestTarget Target { get; init; } = new();

    public IReadOnlyList<DevManifestUser> Users { get; init; } = [];

    public DevManifestDirectoryPolicy? DirectoryPolicy { get; init; }

    public IReadOnlyDictionary<string, string> Environment { get; init; } = new Dictionary<string, string>(StringComparer.Ordinal);

    [JsonIgnore]
    public string ManifestPath { get; private init; } = "";

    [JsonIgnore]
    public string ManifestDirectory => Path.GetDirectoryName(ManifestPath) ?? Directory.GetCurrentDirectory();

    [JsonIgnore]
    public bool HasExplicitHostMode => !string.IsNullOrWhiteSpace(Host.Mode);

    [JsonIgnore]
    public bool HasHostOriginOverride => !string.IsNullOrWhiteSpace(Host.Origin) || Host.Port is not null;

    [JsonIgnore]
    public bool HasHostCommand => !string.IsNullOrWhiteSpace(Host.Command);

    public static DevManifest Load(string path)
    {
        var manifestPath = Path.GetFullPath(Directory.Exists(path) ? Path.Combine(path, "metadata.dev.json") : path);
        if (!File.Exists(manifestPath))
        {
            throw new CommandUsageException($"Dev manifest was not found: {manifestPath}", DevCommand.Usage);
        }

        var raw = File.ReadAllText(manifestPath);
        if (LooksLikeModuleDevMetadata(raw))
        {
            var metadataManifest = FromModuleDevMetadata(raw, manifestPath);
            metadataManifest.Validate();
            return metadataManifest;
        }

        DevManifest? manifest;
        try
        {
            manifest = JsonSerializer.Deserialize<DevManifest>(raw, JsonOptions);
        }
        catch (JsonException ex)
        {
            throw new CommandUsageException($"Dev manifest is not valid JSON: {ex.Message}", DevCommand.Usage);
        }

        if (manifest is null)
        {
            throw new CommandUsageException("Dev manifest is empty.", DevCommand.Usage);
        }

        manifest = manifest with { ManifestPath = manifestPath };
        manifest.Validate();
        return manifest;
    }

    private static bool LooksLikeModuleDevMetadata(string raw)
    {
        try
        {
            using var document = JsonDocument.Parse(raw, new JsonDocumentOptions
            {
                AllowTrailingCommas = true,
                CommentHandling = JsonCommentHandling.Skip,
            });
            return document.RootElement.ValueKind == JsonValueKind.Object &&
                document.RootElement.TryGetProperty("services", out var services) &&
                services.ValueKind == JsonValueKind.Array;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static DevManifest FromModuleDevMetadata(string raw, string manifestPath)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(raw, new JsonDocumentOptions
            {
                AllowTrailingCommas = true,
                CommentHandling = JsonCommentHandling.Skip,
            });
        }
        catch (JsonException ex)
        {
            throw new CommandUsageException($"Dev metadata is not valid JSON: {ex.Message}", DevCommand.Usage);
        }

        using (document)
        {
            var root = document.RootElement;
            var moduleId = ReadRequiredString(root, "id", "Dev metadata id is required.");
            var endpoint = SelectDevEndpoint(root);
            var service = FindService(root, endpoint.ServiceKey);
            var source = service.GetProperty("source");
            if (!source.TryGetProperty("type", out var sourceType) ||
                sourceType.ValueKind != JsonValueKind.String ||
                sourceType.GetString() != "process")
            {
                throw new CommandUsageException("metadata.dev.json must select a process service for docker-host dev up.", DevCommand.Usage);
            }

            var command = ReadRequiredString(source, "command", "Process service source.command is required.");
            var servicePort = FindServicePort(service, endpoint.PortKey);
            var localPort = servicePort.TryGetProperty("localPort", out var localPortElement) &&
                localPortElement.TryGetInt32(out var parsedLocalPort)
                ? parsedLocalPort
                : ReadRequiredInt32(servicePort, "containerPort", "Process service port requires containerPort or localPort.");

            var environment = source.TryGetProperty("environment", out var environmentElement) &&
                environmentElement.ValueKind == JsonValueKind.Object
                ? environmentElement.EnumerateObject()
                    .Where(property => property.Value.ValueKind == JsonValueKind.String)
                    .ToDictionary(property => property.Name, property => property.Value.GetString() ?? "", StringComparer.Ordinal)
                : new Dictionary<string, string>(StringComparer.Ordinal);

            if (!environment.ContainsKey("PORT"))
            {
                environment["PORT"] = localPort.ToString(CultureInfo.InvariantCulture);
            }

            var targetHostname = $"{SanitizeIdentifier(moduleId).Replace('_', '-')}.localhost";
            if (targetHostname.Length > 63)
            {
                targetHostname = $"{targetHostname[..52].TrimEnd('-')}.localhost";
            }

            return new DevManifest
            {
                MetadataFile = Path.GetFileName(manifestPath),
                ModuleCommand = command,
                WorkingDirectory = source.TryGetProperty("workingDirectory", out var workingDirectory) &&
                    workingDirectory.ValueKind == JsonValueKind.String
                    ? workingDirectory.GetString()
                    : ".",
                Target = new DevManifestTarget
                {
                    Hostname = targetHostname,
                    PortKey = endpoint.EndpointKey,
                    LocalPort = localPort,
                },
                Environment = environment,
                ManifestPath = manifestPath,
            };
        }
    }

    private static (string EndpointKey, string ServiceKey, string PortKey) SelectDevEndpoint(JsonElement root)
    {
        var preferredEndpoint = root.TryGetProperty("ui", out var ui) &&
            ui.ValueKind == JsonValueKind.Object &&
            ui.TryGetProperty("entrypoint", out var entrypoint) &&
            entrypoint.ValueKind == JsonValueKind.Object &&
            entrypoint.TryGetProperty("portKey", out var uiPortKey) &&
            uiPortKey.ValueKind == JsonValueKind.String
            ? uiPortKey.GetString()
            : null;

        if (!root.TryGetProperty("endpoints", out var endpoints) || endpoints.ValueKind != JsonValueKind.Array)
        {
            throw new CommandUsageException("Dev metadata endpoints must include a public endpoint.", DevCommand.Usage);
        }

        foreach (var endpoint in endpoints.EnumerateArray())
        {
            if (endpoint.ValueKind != JsonValueKind.Object ||
                !endpoint.TryGetProperty("key", out var key) ||
                key.ValueKind != JsonValueKind.String ||
                !endpoint.TryGetProperty("port", out var port) ||
                port.ValueKind != JsonValueKind.String ||
                !endpoint.TryGetProperty("public", out var isPublic) ||
                isPublic.ValueKind != JsonValueKind.True) {
                continue;
            }

            var endpointKey = key.GetString() ?? "";
            if (!string.IsNullOrWhiteSpace(preferredEndpoint) && endpointKey != preferredEndpoint)
            {
                continue;
            }

            var serviceKey = endpoint.TryGetProperty("service", out var service) && service.ValueKind == JsonValueKind.String
                ? service.GetString()
                : endpoint.TryGetProperty("container", out var container) && container.ValueKind == JsonValueKind.String
                    ? container.GetString()
                    : null;
            if (!string.IsNullOrWhiteSpace(serviceKey))
            {
                return (endpointKey, serviceKey!, port.GetString() ?? "");
            }
        }

        throw new CommandUsageException("Dev metadata endpoints must include a public service endpoint.", DevCommand.Usage);
    }

    private static JsonElement FindService(JsonElement root, string serviceKey)
    {
        foreach (var service in root.GetProperty("services").EnumerateArray())
        {
            if (service.ValueKind == JsonValueKind.Object &&
                service.TryGetProperty("key", out var key) &&
                key.ValueKind == JsonValueKind.String &&
                key.GetString() == serviceKey)
            {
                return service;
            }
        }

        throw new CommandUsageException($"Dev metadata service \"{serviceKey}\" was not found.", DevCommand.Usage);
    }

    private static JsonElement FindServicePort(JsonElement service, string portKey)
    {
        if (!service.TryGetProperty("runtime", out var runtime) ||
            runtime.ValueKind != JsonValueKind.Object ||
            !runtime.TryGetProperty("ports", out var ports) ||
            ports.ValueKind != JsonValueKind.Array)
        {
            throw new CommandUsageException("Process service runtime.ports must include the selected endpoint port.", DevCommand.Usage);
        }

        foreach (var port in ports.EnumerateArray())
        {
            if (port.ValueKind == JsonValueKind.Object &&
                port.TryGetProperty("key", out var key) &&
                key.ValueKind == JsonValueKind.String &&
                key.GetString() == portKey)
            {
                return port;
            }
        }

        throw new CommandUsageException($"Process service port \"{portKey}\" was not found.", DevCommand.Usage);
    }

    private static string ReadRequiredString(JsonElement value, string propertyName, string message)
    {
        if (value.TryGetProperty(propertyName, out var property) &&
            property.ValueKind == JsonValueKind.String &&
            !string.IsNullOrWhiteSpace(property.GetString()))
        {
            return property.GetString()!.Trim();
        }

        throw new CommandUsageException(message, DevCommand.Usage);
    }

    private static int ReadRequiredInt32(JsonElement value, string propertyName, string message)
    {
        if (value.TryGetProperty(propertyName, out var property) &&
            property.TryGetInt32(out var result))
        {
            return result;
        }

        throw new CommandUsageException(message, DevCommand.Usage);
    }

    public string ResolveWorkingDirectory()
        => ResolveOptionalPath(WorkingDirectory) ?? ManifestDirectory;

    public string? ResolveMetadataFile()
        => ResolveOptionalPath(MetadataFile);

    public string? ResolveHostWorkingDirectory()
        => ResolveOptionalPath(Host.WorkingDirectory);

    public DevHostMode GetHostMode()
        => ParseHostMode(Host.Mode);

    public Uri? GetHostOrigin(DevHostMode? mode = null)
    {
        var hostMode = mode ?? GetHostMode();
        if (!string.IsNullOrWhiteSpace(Host.Origin))
        {
            return NormalizeOrigin(Host.Origin);
        }

        if (Host.Port is not null)
        {
            return BuildLoopbackOrigin(Host.Port.Value);
        }

        return hostMode switch
        {
            DevHostMode.LocalProcess => BuildLoopbackOrigin(DefaultLocalHostPort),
            DevHostMode.External => null,
            _ => null,
        };
    }

    public string GetTargetBaseUrl(DevHostMode hostMode)
    {
        if (!string.IsNullOrWhiteSpace(Target.TargetBaseUrl))
        {
            return Target.TargetBaseUrl.Trim();
        }

        if (Target.LocalPort is null)
        {
            throw new CommandUsageException(
                "Dev manifest target requires targetBaseUrl or localPort.",
                DevCommand.Usage);
        }

        var host = hostMode == DevHostMode.DockerContainer
            ? "host.docker.internal"
            : IPAddress.Loopback.ToString();
        return $"http://{host}:{Target.LocalPort.Value.ToString(CultureInfo.InvariantCulture)}";
    }

    public string GetTargetId()
        => string.IsNullOrWhiteSpace(Target.Id)
            ? $"mdev_{SanitizeIdentifier(Target.Hostname)}"
            : Target.Id.Trim();

    public string GetPassword(DevManifestUser user)
    {
        if (!string.IsNullOrWhiteSpace(user.Password))
        {
            return user.Password;
        }

        return user.Role == "host.admin" ? DefaultAdminPassword : DefaultUserPassword;
    }

    private void Validate()
    {
        var hostMode = GetHostMode();
        if (string.IsNullOrWhiteSpace(MetadataUrl) && string.IsNullOrWhiteSpace(MetadataFile))
        {
            throw new CommandUsageException("Dev manifest requires metadataUrl or metadataFile.", DevCommand.Usage);
        }

        if (!string.IsNullOrWhiteSpace(MetadataUrl) && !Uri.TryCreate(MetadataUrl, UriKind.Absolute, out _))
        {
            throw new CommandUsageException("Dev manifest metadataUrl must be an absolute URL.", DevCommand.Usage);
        }

        if (!string.IsNullOrWhiteSpace(Host.Origin))
        {
            _ = NormalizeOrigin(Host.Origin);
        }

        if (Host.Port is not null && (Host.Port <= 0 || Host.Port > 65535))
        {
            throw new CommandUsageException("Dev manifest host.port must be between 1 and 65535.", DevCommand.Usage);
        }

        if (hostMode == DevHostMode.External && GetHostOrigin(hostMode) is null)
        {
            throw new CommandUsageException("Dev manifest host.origin or host.port is required when host.mode is external.", DevCommand.Usage);
        }

        if (string.IsNullOrWhiteSpace(Target.Hostname))
        {
            throw new CommandUsageException("Dev manifest target.hostname is required.", DevCommand.Usage);
        }

        if (string.IsNullOrWhiteSpace(Target.PortKey))
        {
            throw new CommandUsageException("Dev manifest target.portKey is required.", DevCommand.Usage);
        }

        if (string.IsNullOrWhiteSpace(Target.TargetBaseUrl) && Target.LocalPort is null)
        {
            throw new CommandUsageException("Dev manifest target requires targetBaseUrl or localPort.", DevCommand.Usage);
        }

        if (!string.IsNullOrWhiteSpace(Target.TargetBaseUrl) &&
            (!Uri.TryCreate(Target.TargetBaseUrl, UriKind.Absolute, out var targetUrl) ||
                targetUrl.Scheme != Uri.UriSchemeHttp))
        {
            throw new CommandUsageException("Dev manifest target.targetBaseUrl must be an absolute http URL.", DevCommand.Usage);
        }

        if (Target.LocalPort is not null && (Target.LocalPort <= 0 || Target.LocalPort > 65535))
        {
            throw new CommandUsageException("Dev manifest target.localPort must be between 1 and 65535.", DevCommand.Usage);
        }

        if (Target.Policy is not null && Target.Policy is not "public" and not "loginRequired" and not "assignedUsersOnly")
        {
            throw new CommandUsageException("Dev manifest target.policy must be public, loginRequired, or assignedUsersOnly.", DevCommand.Usage);
        }

        if (Target.Identity is not null && Target.Identity is not "none" and not "optional" and not "required")
        {
            throw new CommandUsageException("Dev manifest target.identity must be none, optional, or required.", DevCommand.Usage);
        }

        var seenEmails = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var user in Users)
        {
            if (string.IsNullOrWhiteSpace(user.Email))
            {
                throw new CommandUsageException("Dev manifest users[].email is required.", DevCommand.Usage);
            }

            if (user.Role is not "host.admin" and not "host.user")
            {
                throw new CommandUsageException("Dev manifest users[].role must be host.admin or host.user.", DevCommand.Usage);
            }

            if (!seenEmails.Add(user.Email.Trim()))
            {
                throw new CommandUsageException($"Dev manifest contains duplicate user email: {user.Email}", DevCommand.Usage);
            }
        }
    }

    private string? ResolveOptionalPath(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        return Path.GetFullPath(Path.IsPathFullyQualified(value) ? value : Path.Combine(ManifestDirectory, value));
    }

    private static DevHostMode ParseHostMode(string? value)
    {
        var normalized = string.IsNullOrWhiteSpace(value)
            ? "docker-container"
            : value.Trim().ToLowerInvariant();

        return normalized switch
        {
            "docker-container" or "docker" => DevHostMode.DockerContainer,
            "local-process" or "local" => DevHostMode.LocalProcess,
            "external" or "connect" => DevHostMode.External,
            _ => throw new CommandUsageException(
                "Dev manifest host.mode must be docker-container, local-process, or external.",
                DevCommand.Usage),
        };
    }

    private static Uri NormalizeOrigin(string value)
    {
        if (!Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            throw new CommandUsageException("Dev manifest host.origin must be an absolute HTTP(S) origin.", DevCommand.Usage);
        }

        return new Uri(uri.GetLeftPart(UriPartial.Authority));
    }

    private static Uri BuildLoopbackOrigin(int port)
        => new($"http://localhost:{port.ToString(CultureInfo.InvariantCulture)}");

    private static string SanitizeIdentifier(string value)
    {
        var sanitized = new string(value.Trim().ToLowerInvariant()
            .Select(character => char.IsAsciiLetterOrDigit(character) ? character : '_')
            .ToArray())
            .Trim('_');

        return string.IsNullOrWhiteSpace(sanitized) ? "local_module" : sanitized;
    }
}

internal sealed record DevManifestHost
{
    public string? Mode { get; init; }

    public string? Origin { get; init; }

    public int? Port { get; init; }

    public string? Command { get; init; }

    public string? WorkingDirectory { get; init; }

    public IReadOnlyDictionary<string, string> Environment { get; init; } = new Dictionary<string, string>(StringComparer.Ordinal);
}

internal sealed record DevManifestTarget
{
    public string? Id { get; init; }

    public string Hostname { get; init; } = "";

    public string PortKey { get; init; } = "";

    public string TargetBaseUrl { get; init; } = "";

    public int? LocalPort { get; init; }

    public string? Policy { get; init; }

    public string? Identity { get; init; }
}

internal sealed record DevManifestUser
{
    public string Email { get; init; } = "";

    public string? DisplayName { get; init; }

    public string Role { get; init; } = "host.user";

    public bool Assigned { get; init; }

    public string? Password { get; init; }
}

internal sealed record DevManifestDirectoryPolicy
{
    public bool IncludeEmail { get; init; }
}
