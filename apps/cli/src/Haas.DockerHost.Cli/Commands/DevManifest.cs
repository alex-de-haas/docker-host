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

    public static DevManifest Load(string path)
    {
        var manifestPath = Path.GetFullPath(path);
        if (!File.Exists(manifestPath))
        {
            throw new CommandUsageException($"Dev manifest was not found: {manifestPath}", DevCommand.Usage);
        }

        DevManifest? manifest;
        try
        {
            manifest = JsonSerializer.Deserialize<DevManifest>(File.ReadAllText(manifestPath), JsonOptions);
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
