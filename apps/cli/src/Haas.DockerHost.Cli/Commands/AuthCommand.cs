namespace Haas.DockerHost.Cli.Commands;

using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Haas.DockerHost.Cli.Configuration;
using Haas.DockerHost.Cli.Docker;
using Spectre.Console;

internal sealed class AuthCommand(CommandContext context)
{
    private const string SchemaVersion = "0.1";
    private static readonly TimeSpan SetupTokenLifetime = TimeSpan.FromMinutes(15);
    private static readonly TimeSpan AuthStateLockTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan AuthStateLockStaleAfter = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan AuthStateLockRetryDelay = TimeSpan.FromMilliseconds(50);
    private const string Usage = """
        Usage:
          hosty auth setup-token
          hosty auth recovery-token

        Commands:
          setup-token    Create a one-time setup token for the first Host administrator.
          recovery-token Create a one-time recovery token through local machine access.
        """;

    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length == 0 || args is ["--help"] or ["-h"] or ["help"])
        {
            context.Console.WriteLine(Usage);
            return 0;
        }

        return args[0] switch
        {
            "setup-token" => await CreateSetupTokenAsync(args[1..]),
            "recovery-token" => await CreateRecoveryTokenAsync(args[1..]),
            _ => throw new CommandUsageException($"Unknown auth command '{args[0]}'.", Usage),
        };
    }

    private async Task<int> CreateSetupTokenAsync(string[] args)
        => await CreateLocalSetupTokenAsync(
            args,
            "first-admin",
            requireNoAdmin: true,
            "Setup token created.",
            "auth setup-token does not accept arguments.",
            "Usage: hosty auth setup-token");

    private async Task<int> CreateRecoveryTokenAsync(string[] args)
        => await CreateLocalSetupTokenAsync(
            args,
            "recovery",
            requireNoAdmin: false,
            "Recovery token created.",
            "auth recovery-token does not accept arguments.",
            "Usage: hosty auth recovery-token");

    private async Task<int> CreateLocalSetupTokenAsync(
        string[] args,
        string purpose,
        bool requireNoAdmin,
        string successMessage,
        string usageError,
        string usage)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException(usageError, usage);
        }

        var settings = context.SettingsStore.EnsureInstalled();
        var dataRoot = settings.ResolveHostDataRoot(context.Environment);
        var authRoot = Path.Combine(dataRoot, "auth");
        var statePath = Path.Combine(authRoot, "state.json");
        try
        {
            Directory.CreateDirectory(authRoot);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw CreateAuthStateAccessException(authRoot, ex);
        }

        string token;
        DateTimeOffset expiresAt;
        JsonObject tokenRecord;

        await using (await AcquireAuthStateLockAsync(statePath))
        {
            var state = await ReadAuthStateAsync(statePath);
            if (requireNoAdmin && AdminExists(state))
            {
                context.Console.MarkupLine("[yellow]A Host administrator already exists.[/]");
                return 1;
            }

            token = "dhstp_" + Base64Url(RandomNumberGenerator.GetBytes(32));
            var now = DateTimeOffset.UtcNow;
            expiresAt = now.Add(SetupTokenLifetime);
            tokenRecord = new JsonObject
            {
                ["id"] = "setup_" + Guid.NewGuid().ToString("D"),
                ["tokenHash"] = Sha256Base64Url(token),
                ["createdAt"] = now.ToString("O"),
                ["expiresAt"] = expiresAt.ToString("O"),
                ["purpose"] = purpose,
            };

            var setupTokens = state["setupTokens"] as JsonArray ?? new JsonArray();
            setupTokens.Add(tokenRecord);
            state["setupTokens"] = setupTokens;
            state["updatedAt"] = now.ToString("O");

            await WriteAuthStateAsync(statePath, state);
        }

        await AppendLocalAuthAuditEventAsync(
            authRoot,
            purpose == "first-admin" ? "auth.setup_token.created" : "auth.recovery_token.created",
            new JsonObject
            {
                ["tokenId"] = tokenRecord["id"]?.GetValue<string>(),
                ["expiresAt"] = expiresAt.ToString("O"),
            });

        var setupUrl = await TryResolveSetupUrlAsync(settings, token);
        context.Console.MarkupLine($"[green]{Markup.Escape(successMessage)}[/]");
        context.Console.MarkupLine($"[grey]Expires:[/] {Markup.Escape(expiresAt.LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss"))}");
        context.Console.MarkupLine($"[grey]Token:[/] {Markup.Escape(token)}");
        if (purpose == "first-admin" && setupUrl is not null)
        {
            context.Console.MarkupLine($"[grey]Setup URL:[/] {Markup.Escape(setupUrl)}");
        }
        else if (purpose == "first-admin")
        {
            context.Console.MarkupLine("[grey]Next step:[/] Start Docker Host, then open /setup and enter the token.");
        }
        else
        {
            context.Console.MarkupLine("[grey]Next step:[/] Open the Host recovery flow and enter the token.");
        }

        return 0;
    }

    private async Task<string?> TryResolveSetupUrlAsync(LaunchSettings settings, string token)
    {
        var baseUrl = await TryResolveHostUrlAsync(settings);
        return baseUrl is null ? null : $"{baseUrl}/setup?setupToken={Uri.EscapeDataString(token)}";
    }

    private async Task<string?> TryResolveHostUrlAsync(LaunchSettings settings)
    {
        try
        {
            using var docker = context.DockerFactory.Create(settings.HostDockerEndpoint);
            var container = await docker.InspectContainerAsync(settings.HostContainerName);
            return HostLifecycle.TryGetHostUrl(container, settings);
        }
        catch (DockerEngineException)
        {
            return null;
        }
    }

    private static async Task<JsonObject> ReadAuthStateAsync(string statePath)
    {
        if (!File.Exists(statePath))
        {
            return CreateEmptyAuthState();
        }

        try
        {
            var parsed = JsonNode.Parse(await File.ReadAllTextAsync(statePath, Encoding.UTF8));
            return parsed as JsonObject ?? CreateEmptyAuthState();
        }
        catch (JsonException)
        {
            throw new ConfigurationException($"Unable to parse auth state '{statePath}'.");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw CreateAuthStateAccessException(statePath, ex);
        }
    }

    private static async Task WriteAuthStateAsync(string statePath, JsonObject state)
    {
        state["schemaVersion"] = SchemaVersion;
        state["users"] ??= new JsonArray();
        state["sessions"] ??= new JsonArray();
        state["setupTokens"] ??= new JsonArray();

        var tempPath = statePath + $".{Environment.ProcessId}.{Guid.NewGuid():N}.tmp";
        try
        {
            await File.WriteAllTextAsync(
                tempPath,
                state.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine,
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            File.Move(tempPath, statePath, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            DeleteTemporaryAuthStateFile(tempPath);
            throw CreateAuthStateAccessException(statePath, ex);
        }
    }

    private static async Task<AuthStateLock> AcquireAuthStateLockAsync(string statePath)
    {
        var lockPath = statePath + ".lock";
        var startedAt = DateTimeOffset.UtcNow;

        while (true)
        {
            try
            {
                var stream = new FileStream(
                    lockPath,
                    FileMode.CreateNew,
                    FileAccess.ReadWrite,
                    FileShare.None,
                    bufferSize: 1,
                    FileOptions.Asynchronous);
                var content = Encoding.UTF8.GetBytes(Environment.ProcessId.ToString());
                await stream.WriteAsync(content);
                await stream.FlushAsync();
                return new AuthStateLock(lockPath, stream);
            }
            catch (UnauthorizedAccessException ex)
            {
                throw CreateAuthStateAccessException(lockPath, ex);
            }
            catch (IOException) when (DateTimeOffset.UtcNow - startedAt < AuthStateLockTimeout)
            {
                DeleteStaleAuthStateLock(lockPath);
                await Task.Delay(AuthStateLockRetryDelay);
            }
            catch (IOException ex)
            {
                throw new ConfigurationException(
                    $"Unable to acquire auth state lock '{lockPath}' within {AuthStateLockTimeout.TotalSeconds:0} seconds. " +
                    $"If no hosty auth command is running, remove the lock file or fix ownership and permissions. {ex.Message}");
            }
        }
    }

    private static ConfigurationException CreateAuthStateAccessException(string path, Exception ex)
        => new(
            $"Unable to access auth state path '{path}': {ex.Message} " +
            "Ensure the current user owns the Docker Host data directory and can write to it.");

    private static void DeleteStaleAuthStateLock(string lockPath)
    {
        try
        {
            if (DateTimeOffset.UtcNow - File.GetLastWriteTimeUtc(lockPath) >= AuthStateLockStaleAfter)
            {
                File.Delete(lockPath);
            }
        }
        catch (FileNotFoundException)
        {
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private static async Task AppendLocalAuthAuditEventAsync(string authRoot, string type, JsonObject details)
    {
        var auditPath = Path.Combine(authRoot, "audit.ndjson");
        var auditEvent = new JsonObject
        {
            ["id"] = "evt_" + Guid.NewGuid().ToString("D"),
            ["type"] = type,
            ["createdAt"] = DateTimeOffset.UtcNow.ToString("O"),
            ["success"] = true,
            ["details"] = details,
        };

        try
        {
            Directory.CreateDirectory(authRoot);
            await File.AppendAllTextAsync(
                auditPath,
                auditEvent.ToJsonString(new JsonSerializerOptions { WriteIndented = false }) + Environment.NewLine,
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw CreateAuthStateAccessException(auditPath, ex);
        }
    }

    private static void DeleteTemporaryAuthStateFile(string tempPath)
    {
        try
        {
            File.Delete(tempPath);
        }
        catch (FileNotFoundException)
        {
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private static JsonObject CreateEmptyAuthState()
        => new()
        {
            ["schemaVersion"] = SchemaVersion,
            ["users"] = new JsonArray(),
            ["sessions"] = new JsonArray(),
            ["setupTokens"] = new JsonArray(),
            ["updatedAt"] = DateTimeOffset.UtcNow.ToString("O"),
        };

    private static bool AdminExists(JsonObject state)
    {
        if (state["users"] is not JsonArray users)
        {
            return false;
        }

        foreach (var user in users)
        {
            if (user is not JsonObject userObject)
            {
                continue;
            }

            if (string.Equals(userObject["role"]?.GetValue<string>(), "host.admin", StringComparison.Ordinal) &&
                userObject["disabled"]?.GetValue<bool>() != true)
            {
                return true;
            }
        }

        return false;
    }

    private static string Sha256Base64Url(string value)
        => Base64Url(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static string Base64Url(byte[] bytes)
        => Convert.ToBase64String(bytes)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');

    private sealed class AuthStateLock(string lockPath, FileStream stream) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await stream.DisposeAsync();
            try
            {
                File.Delete(lockPath);
            }
            catch (FileNotFoundException)
            {
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

}
