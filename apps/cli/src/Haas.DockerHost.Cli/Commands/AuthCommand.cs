namespace Haas.DockerHost.Cli.Commands;

using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Haas.DockerHost.Cli.Configuration;
using Haas.DockerHost.Cli.Docker;
using Haas.DockerHost.Cli.HostApi;
using Spectre.Console;

internal sealed class AuthCommand(CommandContext context)
{
    private const string SchemaVersion = "0.1";
    private static readonly TimeSpan SetupTokenLifetime = TimeSpan.FromMinutes(15);
    private const string Usage = """
        Usage:
          docker-host auth setup-token
          docker-host auth recovery-token
          docker-host auth token import <token> [--host <url>] [--token-id <id>] [--label <label>]
          docker-host auth token status
          docker-host auth token logout
          docker-host auth token list
          docker-host auth token create [--label <label>] [--user-id <id>]
          docker-host auth token revoke <token-id>
          docker-host auth token rotate [token-id] [--label <label>]

        Commands:
          setup-token    Create a one-time setup token for the first Host administrator.
          recovery-token Create a one-time recovery token through local machine access.
          token import   Store an existing CLI admin token locally.
          token status   Show the locally stored CLI token metadata.
          token logout   Remove the locally stored CLI token.
          token list     List CLI admin tokens from the Host.
          token create   Create a new CLI admin token and store it locally.
          token revoke   Revoke a CLI admin token.
          token rotate   Replace a CLI admin token and store the replacement locally.
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
            "token" => await ExecuteTokenAsync(args[1..]),
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
            "Usage: docker-host auth setup-token");

    private async Task<int> CreateRecoveryTokenAsync(string[] args)
        => await CreateLocalSetupTokenAsync(
            args,
            "recovery",
            requireNoAdmin: false,
            "Recovery token created.",
            "auth recovery-token does not accept arguments.",
            "Usage: docker-host auth recovery-token");

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
        Directory.CreateDirectory(authRoot);

        var state = await ReadAuthStateAsync(statePath);
        if (requireNoAdmin && AdminExists(state))
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
            ["purpose"] = purpose,
        };

        var setupTokens = state["setupTokens"] as JsonArray ?? new JsonArray();
        setupTokens.Add(tokenRecord);
        state["setupTokens"] = setupTokens;
        state["updatedAt"] = now.ToString("O");

        await WriteAuthStateAsync(statePath, state);
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

    private async Task<int> ExecuteTokenAsync(string[] args)
    {
        if (args.Length == 0 || args is ["--help"] or ["-h"] or ["help"])
        {
            context.Console.WriteLine(Usage);
            return 0;
        }

        return args[0] switch
        {
            "import" => await ImportTokenAsync(args[1..]),
            "status" => ShowTokenStatus(args[1..]),
            "logout" => LogoutToken(args[1..]),
            "list" => await ListTokensAsync(args[1..]),
            "create" => await CreateCliTokenAsync(args[1..]),
            "revoke" => await RevokeCliTokenAsync(args[1..]),
            "rotate" => await RotateCliTokenAsync(args[1..]),
            _ => throw new CommandUsageException($"Unknown auth token command '{args[0]}'.", Usage),
        };
    }

    private async Task<int> ImportTokenAsync(string[] args)
    {
        var parsed = ParseArguments(args);
        if (parsed.Positionals.Count != 1)
        {
            throw new CommandUsageException("auth token import requires exactly one token.", "Usage: docker-host auth token import <token> [--host <url>] [--token-id <id>] [--label <label>]");
        }

        var token = parsed.Positionals[0].Trim();
        if (string.IsNullOrWhiteSpace(token))
        {
            throw new CommandUsageException("auth token import requires a non-empty token.", "Usage: docker-host auth token import <token>");
        }

        var hostUrl = parsed.Options.TryGetValue("host", out var configuredHost)
            ? HostAuthTokenStore.NormalizeHostUrl(configuredHost)
            : await ResolveCurrentHostUrlForTokenImportAsync();

        if (hostUrl is null)
        {
            context.Console.MarkupLine("[red]Unable to determine the Host URL.[/]");
            context.Console.WriteLine("Start Docker Host first or pass --host <url>.");
            return 1;
        }

        new HostAuthTokenStore(context.Environment).Save(new HostAuthTokenCredential(
            hostUrl,
            token,
            parsed.Options.GetValueOrDefault("token-id"),
            parsed.Options.GetValueOrDefault("label"),
            DateTimeOffset.UtcNow));

        context.Console.MarkupLine("[green]CLI token stored.[/]");
        context.Console.MarkupLine($"[grey]Host:[/] {Markup.Escape(hostUrl)}");
        return 0;
    }

    private int ShowTokenStatus(string[] args)
    {
        if (args.Length != 0)
        {
            throw new CommandUsageException("auth token status does not accept arguments.", "Usage: docker-host auth token status");
        }

        var store = new HostAuthTokenStore(context.Environment);
        if (store.HasEnvironmentOverride())
        {
            context.Console.MarkupLine("[green]CLI token is provided by DOCKER_HOST_CLI_TOKEN.[/]");
            return 0;
        }

        var credential = store.Load();
        if (credential is null)
        {
            context.Console.MarkupLine("[yellow]No CLI token is stored.[/]");
            context.Console.WriteLine("Create a CLI token in Docker Host, then run docker-host auth token import <token>.");
            return 1;
        }

        var table = new Table()
            .RoundedBorder()
            .AddColumn("Property")
            .AddColumn("Value");
        table.AddRow("Host", Markup.Escape(credential.HostUrl));
        table.AddRow("Token id", Markup.Escape(credential.TokenId ?? "(unknown)"));
        table.AddRow("Label", Markup.Escape(credential.Label ?? "(none)"));
        table.AddRow("Stored", Markup.Escape(credential.StoredAt.LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss")));
        context.Console.Write(table);
        return 0;
    }

    private int LogoutToken(string[] args)
    {
        if (args.Length != 0)
        {
            throw new CommandUsageException("auth token logout does not accept arguments.", "Usage: docker-host auth token logout");
        }

        var deleted = new HostAuthTokenStore(context.Environment).Delete();
        context.Console.MarkupLine(deleted
            ? "[green]Stored CLI token removed.[/]"
            : "[yellow]No stored CLI token was found.[/]");
        return 0;
    }

    private async Task<int> ListTokensAsync(string[] args)
    {
        if (args.Length != 0)
        {
            throw new CommandUsageException("auth token list does not accept arguments.", "Usage: docker-host auth token list");
        }

        using var hostApi = await CreateAuthenticatedHostApiClientAsync();
        if (hostApi is null)
        {
            return 1;
        }

        var response = await hostApi.Client.ListCliTokensAsync();
        if (!response.IsSuccess || response.Body is null)
        {
            return RenderApiFailure("Failed to list CLI tokens.", response.StatusCode, response.RawBody);
        }

        RenderCliTokens(response.Body.CliTokens);
        return 0;
    }

    private async Task<int> CreateCliTokenAsync(string[] args)
    {
        var parsed = ParseArguments(args);
        if (parsed.Positionals.Count != 0)
        {
            throw new CommandUsageException("auth token create does not accept positional arguments.", "Usage: docker-host auth token create [--label <label>] [--user-id <id>]");
        }

        using var hostApi = await CreateAuthenticatedHostApiClientAsync();
        if (hostApi is null)
        {
            return 1;
        }

        var response = await hostApi.Client.CreateCliTokenAsync(new CliTokenCreateRequest
        {
            Label = parsed.Options.GetValueOrDefault("label"),
            UserId = parsed.Options.GetValueOrDefault("user-id"),
        });
        if (!response.IsSuccess || response.Body?.CliToken is null || string.IsNullOrWhiteSpace(response.Body.Token))
        {
            return RenderApiFailure("Failed to create CLI token.", response.StatusCode, response.RawBody);
        }

        StoreCreatedToken(hostApi.BaseUri, response.Body.CliToken, response.Body.Token);
        context.Console.MarkupLine("[green]CLI token created and stored locally.[/]");
        context.Console.MarkupLine($"[grey]Token id:[/] {Markup.Escape(response.Body.CliToken.Id)}");
        return 0;
    }

    private async Task<int> RevokeCliTokenAsync(string[] args)
    {
        if (args.Length != 1)
        {
            throw new CommandUsageException("auth token revoke requires exactly one token id.", "Usage: docker-host auth token revoke <token-id>");
        }

        using var hostApi = await CreateAuthenticatedHostApiClientAsync();
        if (hostApi is null)
        {
            return 1;
        }

        var tokenId = args[0].Trim();
        var response = await hostApi.Client.RevokeCliTokenAsync(tokenId);
        if (!response.IsSuccess || response.Body?.Revoked != true)
        {
            return RenderApiFailure("Failed to revoke CLI token.", response.StatusCode, response.RawBody);
        }

        var store = new HostAuthTokenStore(context.Environment);
        if (string.Equals(store.Load()?.TokenId, tokenId, StringComparison.Ordinal))
        {
            store.Delete();
            context.Console.MarkupLine("[yellow]The revoked token was the locally stored token, so it was removed.[/]");
        }

        context.Console.MarkupLine("[green]CLI token revoked.[/]");
        return 0;
    }

    private async Task<int> RotateCliTokenAsync(string[] args)
    {
        var parsed = ParseArguments(args);
        if (parsed.Positionals.Count > 1)
        {
            throw new CommandUsageException("auth token rotate accepts at most one token id.", "Usage: docker-host auth token rotate [token-id] [--label <label>]");
        }

        var store = new HostAuthTokenStore(context.Environment);
        var tokenId = parsed.Positionals.Count == 1
            ? parsed.Positionals[0].Trim()
            : store.Load()?.TokenId;
        if (string.IsNullOrWhiteSpace(tokenId))
        {
            context.Console.MarkupLine("[red]No token id was provided and the stored token has no token id.[/]");
            context.Console.WriteLine("Run docker-host auth token list, then pass the token id explicitly.");
            return 1;
        }

        using var hostApi = await CreateAuthenticatedHostApiClientAsync();
        if (hostApi is null)
        {
            return 1;
        }

        var response = await hostApi.Client.RotateCliTokenAsync(tokenId, new CliTokenRotateRequest
        {
            Label = parsed.Options.GetValueOrDefault("label"),
        });
        if (!response.IsSuccess || response.Body?.CliToken is null || string.IsNullOrWhiteSpace(response.Body.Token))
        {
            return RenderApiFailure("Failed to rotate CLI token.", response.StatusCode, response.RawBody);
        }

        StoreCreatedToken(hostApi.BaseUri, response.Body.CliToken, response.Body.Token);
        context.Console.MarkupLine("[green]CLI token rotated and replacement stored locally.[/]");
        context.Console.MarkupLine($"[grey]New token id:[/] {Markup.Escape(response.Body.CliToken.Id)}");
        return 0;
    }

    private async Task<string?> TryResolveSetupUrlAsync(LaunchSettings settings, string token)
    {
        var baseUrl = await TryResolveHostUrlAsync(settings);
        return baseUrl is null ? null : $"{baseUrl}/setup?setupToken={Uri.EscapeDataString(token)}";
    }

    private async Task<string?> ResolveCurrentHostUrlForTokenImportAsync()
    {
        var settings = context.SettingsStore.EnsureInstalled();
        return await TryResolveHostUrlAsync(settings);
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

    private async Task<AuthenticatedHostApiClient?> CreateAuthenticatedHostApiClientAsync()
    {
        var settings = context.SettingsStore.Load();
        settings.Validate(context.Environment);

        var baseUrl = await TryResolveHostUrlAsync(settings);
        if (baseUrl is null)
        {
            context.Console.MarkupLine("[red]Unable to determine the Host API URL.[/]");
            context.Console.WriteLine("Run docker-host start first.");
            return null;
        }

        var baseUri = new Uri(baseUrl);
        var tokenStore = new HostAuthTokenStore(context.Environment);
        var token = tokenStore.GetTokenForHost(baseUri);
        if (string.IsNullOrWhiteSpace(token))
        {
            context.Console.MarkupLine("[red]No CLI auth token is stored for this Host.[/]");
            context.Console.WriteLine("Create a CLI token in Docker Host, then run docker-host auth token import <token>.");
            return null;
        }

        return new AuthenticatedHostApiClient(context.HostApiFactory.Create(baseUri, token), baseUri);
    }

    private void StoreCreatedToken(Uri hostUrl, CliTokenSummary cliToken, string token)
    {
        new HostAuthTokenStore(context.Environment).Save(new HostAuthTokenCredential(
            HostAuthTokenStore.NormalizeHostUrl(hostUrl),
            token,
            cliToken.Id,
            cliToken.Label,
            DateTimeOffset.UtcNow));
    }

    private void RenderCliTokens(IReadOnlyList<CliTokenSummary> tokens)
    {
        if (tokens.Count == 0)
        {
            context.Console.MarkupLine("[yellow]No CLI tokens.[/]");
            return;
        }

        var table = new Table()
            .RoundedBorder()
            .AddColumn("Token id")
            .AddColumn("User")
            .AddColumn("Label")
            .AddColumn("Created")
            .AddColumn("Last used")
            .AddColumn("Status");

        foreach (var token in tokens)
        {
            table.AddRow(
                Markup.Escape(token.Id),
                Markup.Escape(token.UserId),
                Markup.Escape(token.Label),
                Markup.Escape(token.CreatedAt),
                Markup.Escape(token.LastUsedAt ?? ""),
                Markup.Escape(token.RevokedAt is null ? "active" : $"revoked {token.RevokedAt}"));
        }

        context.Console.Write(table);
    }

    private int RenderApiFailure(string fallback, HttpStatusCode statusCode, string rawBody)
    {
        context.Console.MarkupLine($"[red]{Markup.Escape(fallback)}[/]");
        context.Console.MarkupLine($"[grey]HTTP:[/] {(int)statusCode} {Markup.Escape(statusCode.ToString())}");
        if (!string.IsNullOrWhiteSpace(rawBody))
        {
            context.Console.WriteLine(rawBody);
        }

        return 1;
    }

    private static ParsedArguments ParseArguments(string[] args)
    {
        var positionals = new List<string>();
        var options = new Dictionary<string, string>(StringComparer.Ordinal);

        for (var index = 0; index < args.Length; index++)
        {
            var arg = args[index];
            if (!arg.StartsWith("--", StringComparison.Ordinal))
            {
                positionals.Add(arg);
                continue;
            }

            var option = arg[2..];
            var separator = option.IndexOf('=', StringComparison.Ordinal);
            if (separator >= 0)
            {
                options[option[..separator]] = option[(separator + 1)..];
                continue;
            }

            if (index + 1 >= args.Length || args[index + 1].StartsWith("--", StringComparison.Ordinal))
            {
                throw new CommandUsageException($"Option '{arg}' requires a value.", Usage);
            }

            options[option] = args[++index];
        }

        return new ParsedArguments(positionals, options);
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

    private static async Task AppendLocalAuthAuditEventAsync(string authRoot, string type, JsonObject details)
    {
        Directory.CreateDirectory(authRoot);
        var auditPath = Path.Combine(authRoot, "audit.ndjson");
        var auditEvent = new JsonObject
        {
            ["id"] = "evt_" + Guid.NewGuid().ToString("D"),
            ["type"] = type,
            ["createdAt"] = DateTimeOffset.UtcNow.ToString("O"),
            ["success"] = true,
            ["details"] = details,
        };

        await File.AppendAllTextAsync(
            auditPath,
            auditEvent.ToJsonString(new JsonSerializerOptions { WriteIndented = false }) + Environment.NewLine,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
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

    private sealed record ParsedArguments(
        IReadOnlyList<string> Positionals,
        IReadOnlyDictionary<string, string> Options);

    private sealed class AuthenticatedHostApiClient(HostApiClient client, Uri baseUri) : IDisposable
    {
        public HostApiClient Client { get; } = client;

        public Uri BaseUri { get; } = baseUri;

        public void Dispose() => Client.Dispose();
    }
}
