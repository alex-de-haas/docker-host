namespace Haas.DockerHost.Cli.Commands;

using System.Globalization;
using System.Net;
using System.Text.Json;

internal enum DevHostMode
{
    LocalProcess,
    External,
}

internal sealed record DevManifest
{
    private const string DefaultAdminPassword = "docker-host-dev-admin";
    private const string DefaultUserPassword = "docker-host-dev-user";

    private static readonly JsonDocumentOptions JsonDocumentOptions = new()
    {
        CommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    public string? ModuleCommand { get; init; }

    public string? WorkingDirectory { get; init; }

    public DevManifestTarget Target { get; init; } = new();

    public IReadOnlyList<DevManifestUser> Users { get; init; } = [];

    public DevManifestDirectoryPolicy? DirectoryPolicy { get; init; }

    public IReadOnlyDictionary<string, string> Environment { get; init; } = new Dictionary<string, string>(StringComparer.Ordinal);
    public string ManifestPath { get; private init; } = "";

    public string ManifestDirectory => Path.GetDirectoryName(ManifestPath) ?? Directory.GetCurrentDirectory();

    public static DevManifest Load(string path)
    {
        var manifestPath = Path.GetFullPath(Directory.Exists(path) ? Path.Combine(path, "metadata.dev.json") : path);
        if (!File.Exists(manifestPath))
        {
            throw new CommandUsageException($"Dev metadata was not found: {manifestPath}", DevCommand.Usage);
        }

        var raw = File.ReadAllText(manifestPath);
        using var document = ParseMetadata(raw);
        if (!LooksLikeModuleDevMetadata(document.RootElement))
        {
            throw new CommandUsageException("docker-host dev requires metadata.dev.json with schemaVersion 0.3 process services.", DevCommand.Usage);
        }

        var manifest = FromModuleDevMetadata(document.RootElement, manifestPath);
        manifest.Validate();
        return manifest;
    }

    private static JsonDocument ParseMetadata(string raw)
    {
        try
        {
            return JsonDocument.Parse(raw, JsonDocumentOptions);
        }
        catch (JsonException ex)
        {
            throw new CommandUsageException($"Dev metadata is not valid JSON: {ex.Message}", DevCommand.Usage);
        }
    }

    private static bool LooksLikeModuleDevMetadata(JsonElement root)
        => root.ValueKind == JsonValueKind.Object &&
            root.TryGetProperty("schemaVersion", out var schemaVersion) &&
            schemaVersion.ValueKind == JsonValueKind.String &&
            schemaVersion.GetString() == "0.3" &&
            root.TryGetProperty("services", out var services) &&
            services.ValueKind == JsonValueKind.Array;

    private static DevManifest FromModuleDevMetadata(JsonElement root, string manifestPath)
    {
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
            Users = CreateDefaultUsers(),
            DirectoryPolicy = new DevManifestDirectoryPolicy { IncludeEmail = true },
            Environment = environment,
            ManifestPath = manifestPath,
        };
    }

    private static IReadOnlyList<DevManifestUser> CreateDefaultUsers() =>
        [
            new DevManifestUser
            {
                Email = ReadEnvironmentOverride("HOST_DEV_ADMIN_EMAIL", "admin@docker-host.local"),
                DisplayName = ReadEnvironmentOverride("HOST_DEV_ADMIN_NAME", "Dev Admin"),
                Role = "host.admin",
                Assigned = true,
                Password = ReadEnvironmentOverride("HOST_DEV_ADMIN_PASSWORD"),
            },
            new DevManifestUser
            {
                Email = ReadEnvironmentOverride("HOST_DEV_USER_EMAIL", "user@docker-host.local"),
                DisplayName = ReadEnvironmentOverride("HOST_DEV_USER_NAME", "Dev User"),
                Role = "host.user",
                Assigned = true,
                Password = ReadEnvironmentOverride("HOST_DEV_USER_PASSWORD"),
            },
        ];

    private static string ReadEnvironmentOverride(string key, string fallback)
    {
        var value = System.Environment.GetEnvironmentVariable(key);
        return string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
    }

    private static string? ReadEnvironmentOverride(string key)
    {
        var value = System.Environment.GetEnvironmentVariable(key);
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
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

    public string ResolveMetadataFile()
        => ManifestPath;

    public string GetTargetBaseUrl()
    {
        if (!string.IsNullOrWhiteSpace(Target.TargetBaseUrl))
        {
            return Target.TargetBaseUrl.Trim();
        }

        if (Target.LocalPort is null)
        {
            throw new CommandUsageException(
                "Dev metadata target requires a local port.",
                DevCommand.Usage);
        }

        return $"http://{IPAddress.Loopback}:{Target.LocalPort.Value.ToString(CultureInfo.InvariantCulture)}";
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
        if (string.IsNullOrWhiteSpace(Target.Hostname))
        {
            throw new CommandUsageException("Dev metadata target hostname is required.", DevCommand.Usage);
        }

        if (string.IsNullOrWhiteSpace(Target.PortKey))
        {
            throw new CommandUsageException("Dev metadata target port key is required.", DevCommand.Usage);
        }

        if (string.IsNullOrWhiteSpace(Target.TargetBaseUrl) && Target.LocalPort is null)
        {
            throw new CommandUsageException("Dev metadata target requires a local port.", DevCommand.Usage);
        }

        if (!string.IsNullOrWhiteSpace(Target.TargetBaseUrl) &&
            (!Uri.TryCreate(Target.TargetBaseUrl, UriKind.Absolute, out var targetUrl) ||
                targetUrl.Scheme != Uri.UriSchemeHttp))
        {
            throw new CommandUsageException("Dev metadata target URL must be an absolute http URL.", DevCommand.Usage);
        }

        if (Target.LocalPort is not null && (Target.LocalPort <= 0 || Target.LocalPort > 65535))
        {
            throw new CommandUsageException("Dev metadata target local port must be between 1 and 65535.", DevCommand.Usage);
        }

        if (Target.Policy is not null && Target.Policy is not "public" and not "loginRequired" and not "assignedUsersOnly")
        {
            throw new CommandUsageException("Dev metadata target policy must be public, loginRequired, or assignedUsersOnly.", DevCommand.Usage);
        }

        if (Target.Identity is not null && Target.Identity is not "none" and not "optional" and not "required")
        {
            throw new CommandUsageException("Dev metadata target identity must be none, optional, or required.", DevCommand.Usage);
        }

        var seenEmails = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var user in Users)
        {
            if (string.IsNullOrWhiteSpace(user.Email))
            {
                throw new CommandUsageException("Dev metadata users[].email is required.", DevCommand.Usage);
            }

            if (user.Role is not "host.admin" and not "host.user")
            {
                throw new CommandUsageException("Dev metadata users[].role must be host.admin or host.user.", DevCommand.Usage);
            }

            if (!seenEmails.Add(user.Email.Trim()))
            {
                throw new CommandUsageException($"Dev metadata contains duplicate user email: {user.Email}", DevCommand.Usage);
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

    private static string SanitizeIdentifier(string value)
    {
        var sanitized = new string(value.Trim().ToLowerInvariant()
            .Select(character => char.IsAsciiLetterOrDigit(character) ? character : '_')
            .ToArray())
            .Trim('_');

        return string.IsNullOrWhiteSpace(sanitized) ? "local_module" : sanitized;
    }
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
