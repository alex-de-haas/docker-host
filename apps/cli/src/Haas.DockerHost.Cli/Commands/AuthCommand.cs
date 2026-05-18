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

    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length == 0 || args is ["--help"] or ["-h"] or ["help"])
        {
            context.Console.WriteLine("""
                Usage:
                  docker-host auth setup-token

                Commands:
                  setup-token    Create a one-time setup token for the first Host administrator.
                """);
            return 0;
        }

        return args[0] switch
        {
            "setup-token" => await CreateSetupTokenAsync(args[1..]),
            _ => throw new CommandUsageException($"Unknown auth command '{args[0]}'.", "Usage: docker-host auth setup-token"),
        };
    }

    private async Task<int> CreateSetupTokenAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("auth setup-token does not accept arguments.", "Usage: docker-host auth setup-token");
        }

        var settings = context.SettingsStore.EnsureInstalled();
        var dataRoot = settings.ResolveHostDataRoot(context.Environment);
        var authRoot = Path.Combine(dataRoot, "auth");
        var statePath = Path.Combine(authRoot, "state.json");
        Directory.CreateDirectory(authRoot);

        var state = await ReadAuthStateAsync(statePath);
        if (AdminExists(state))
        {
            context.Console.MarkupLine("[yellow]A Host administrator already exists.[/]");
            return 1;
        }

        var token = "dhstp_" + Base64Url(RandomNumberGenerator.GetBytes(32));
        var now = DateTimeOffset.UtcNow;
        var expiresAt = now.Add(SetupTokenLifetime);
        var tokenRecord = new JsonObject
        {
            ["id"] = "setup_" + Guid.NewGuid().ToString("D"),
            ["tokenHash"] = Sha256Base64Url(token),
            ["createdAt"] = now.ToString("O"),
            ["expiresAt"] = expiresAt.ToString("O"),
            ["purpose"] = "first-admin",
        };

        var setupTokens = state["setupTokens"] as JsonArray ?? new JsonArray();
        setupTokens.Add(tokenRecord);
        state["setupTokens"] = setupTokens;
        state["updatedAt"] = now.ToString("O");

        await WriteAuthStateAsync(statePath, state);

        var setupUrl = await TryResolveSetupUrlAsync(settings, token);
        context.Console.MarkupLine("[green]Setup token created.[/]");
        context.Console.MarkupLine($"[grey]Expires:[/] {Markup.Escape(expiresAt.LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss"))}");
        context.Console.MarkupLine($"[grey]Token:[/] {Markup.Escape(token)}");
        if (setupUrl is not null)
        {
            context.Console.MarkupLine($"[grey]Setup URL:[/] {Markup.Escape(setupUrl)}");
        }
        else
        {
            context.Console.MarkupLine("[grey]Next step:[/] Start Docker Host, then open /setup and enter the token.");
        }

        return 0;
    }

    private async Task<string?> TryResolveSetupUrlAsync(LaunchSettings settings, string token)
    {
        try
        {
            using var docker = context.DockerFactory.Create(settings.HostDockerEndpoint);
            var container = await docker.InspectContainerAsync(settings.HostContainerName);
            var baseUrl = HostLifecycle.TryGetHostUrl(container, settings);
            return baseUrl is null ? null : $"{baseUrl}/setup?setupToken={Uri.EscapeDataString(token)}";
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
    }

    private static async Task WriteAuthStateAsync(string statePath, JsonObject state)
    {
        state["schemaVersion"] = SchemaVersion;
        state["users"] ??= new JsonArray();
        state["sessions"] ??= new JsonArray();
        state["setupTokens"] ??= new JsonArray();
        state["cliTokens"] ??= new JsonArray();

        var tempPath = statePath + ".tmp";
        await File.WriteAllTextAsync(
            tempPath,
            state.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        File.Move(tempPath, statePath, overwrite: true);
    }

    private static JsonObject CreateEmptyAuthState()
        => new()
        {
            ["schemaVersion"] = SchemaVersion,
            ["users"] = new JsonArray(),
            ["sessions"] = new JsonArray(),
            ["setupTokens"] = new JsonArray(),
            ["cliTokens"] = new JsonArray(),
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
}
