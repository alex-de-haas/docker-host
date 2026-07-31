namespace Haas.Hosty.Cli.Commands;

using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Haas.Hosty.Cli.Configuration;
using Spectre.Console;

/// <summary>
/// Sign this machine in to a remote Hosty host.
/// </summary>
/// <remarks>
/// The CLI's local control channel needs no credential — possession of the discovery file on the host is
/// the authorization — but it only works on the host itself. Reaching a Core over the network needs a
/// credential Core will accept, and until now there was no way for a client without a browser to obtain
/// one. See docs/features/access-tokens/.
/// </remarks>
internal sealed partial class LoginCommand(CommandContext context)
{
    [JsonSourceGenerationOptions(
        PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        NumberHandling = JsonNumberHandling.AllowReadingFromString)]
    [JsonSerializable(typeof(DeviceCodeRequest))]
    [JsonSerializable(typeof(DeviceCodeResponse))]
    [JsonSerializable(typeof(DeviceTokenRequest))]
    [JsonSerializable(typeof(DeviceTokenResponse))]
    [JsonSerializable(typeof(SessionProbeResponse))]
    internal partial class LoginJsonContext : JsonSerializerContext;

    private const string Usage = """
        Usage:
          hosty login --host <origin> [--name <context>]
          hosty login --host <origin> --token <value> [--name <context>]
          hosty login --list
          hosty login --use <context>
          hosty logout [--name <context>]

        Options:
          --host   Origin of the Hosty Core to sign in to, e.g. https://hosty.example
          --token  Use a credential created on the Shell Access tokens page instead of
                   the device flow. For a client that cannot show a code to a human.
          --name   Name for this context. Defaults to the host's domain.
          --list   Show configured contexts.
          --use    Make an existing context current.
        """;

    public async Task<int> ExecuteAsync(string[] args, CancellationToken cancellationToken = default)
    {
        if (args is ["--help"] or ["-h"] or ["help"])
        {
            context.Console.WriteLine(Usage);
            return 0;
        }

        var options = ParseOptions(args);
        var store = new ContextStore(context.Environment);

        if (options.List)
        {
            return ListContexts(store);
        }

        if (!string.IsNullOrWhiteSpace(options.Use))
        {
            if (!store.SetCurrent(options.Use))
            {
                context.Console.MarkupLine($"[red]No context named '{options.Use}'.[/]");
                return 1;
            }

            context.Console.MarkupLine($"Current context is now [bold]{options.Use}[/].");
            return 0;
        }

        if (string.IsNullOrWhiteSpace(options.Host))
        {
            throw new CommandUsageException("login requires --host.", Usage);
        }

        var origin = NormalizeOrigin(options.Host);
        var name = string.IsNullOrWhiteSpace(options.Name) ? DefaultContextName(origin) : options.Name;

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        var token = string.IsNullOrWhiteSpace(options.Token)
            ? await RunDeviceFlowAsync(http, origin, name, cancellationToken)
            : options.Token;

        if (token is null)
        {
            return 1;
        }

        // Prove the credential works before storing it, so a typo surfaces here rather than on the next
        // command. This is also what resolves the user behind it for the context listing.
        var probe = await ProbeAsync(http, origin, token, cancellationToken);
        if (probe is null || !probe.Authenticated)
        {
            context.Console.MarkupLine("[red]That credential was not accepted by Core.[/]");
            return 1;
        }

        CredentialStore.Save(context.Environment, name, token);
        store.Upsert(new HostyContext(name, origin, probe.User?.Email ?? probe.User?.DisplayName), makeCurrent: true);

        context.Console.MarkupLine($"Signed in to [bold]{origin}[/] as context [bold]{name}[/].");
        if (probe.User is not null && !string.Equals(probe.User.Role, "host.admin", StringComparison.Ordinal))
        {
            // Core has no scopes: the credential carries the approver's whole role and nothing narrows
            // it. A client that needed an administrator has to be told now, not by a later denial.
            context.Console.MarkupLine("[yellow]This credential belongs to a non-administrator account, so host administration will be denied.[/]");
        }

        context.Console.MarkupLine($"[dim]Credential stored in {CredentialStore.LocationDescription(context.Environment)}.[/]");
        return 0;
    }

    public int Logout(string[] args)
    {
        var options = ParseOptions(args);
        var store = new ContextStore(context.Environment);
        var contexts = store.Read();
        var name = string.IsNullOrWhiteSpace(options.Name) ? contexts.Current : options.Name;

        if (string.IsNullOrWhiteSpace(name) || !store.Remove(name))
        {
            context.Console.MarkupLine("[yellow]No such context.[/]");
            return 1;
        }

        context.Console.MarkupLine($"Removed context [bold]{name}[/].");
        context.Console.MarkupLine("[dim]The credential is gone from this machine. Revoke it in Shell if it may have been copied.[/]");
        return 0;
    }

    private int ListContexts(ContextStore store)
    {
        var contexts = store.Read();
        if (contexts.Contexts.Count == 0)
        {
            context.Console.MarkupLine("[yellow]No contexts configured.[/] Run `hosty login --host <origin>`.");
            return 0;
        }

        var table = new Table().Border(TableBorder.Rounded);
        table.AddColumn("Context");
        table.AddColumn("Host");
        table.AddColumn("User");
        foreach (var entry in contexts.Contexts)
        {
            var current = string.Equals(entry.Name, contexts.Current, StringComparison.Ordinal);
            table.AddRow(
                current ? $"[bold]{entry.Name} *[/]" : entry.Name,
                entry.Origin,
                entry.User ?? "[dim]unknown[/]");
        }

        context.Console.Write(table);
        return 0;
    }

    private async Task<string?> RunDeviceFlowAsync(HttpClient http, string origin, string label, CancellationToken cancellationToken)
    {
        var start = await http.PostAsJsonAsync(
            $"{origin}/api/auth/device/code",
            new DeviceCodeRequest(label),
            CliJson.TypeInfo<DeviceCodeRequest>(),
            cancellationToken);
        if (!start.IsSuccessStatusCode)
        {
            context.Console.MarkupLine($"[red]Core refused to start a device authorization ({(int)start.StatusCode}).[/]");
            return null;
        }

        var request = await start.Content.ReadFromJsonAsync(CliJson.TypeInfo<DeviceCodeResponse>(), cancellationToken);
        if (request is null)
        {
            context.Console.MarkupLine("[red]Core returned an unreadable device authorization response.[/]");
            return null;
        }

        context.Console.WriteLine();
        context.Console.MarkupLine($"Enter this code in Shell:  [bold]{FormatUserCode(request.UserCode)}[/]");
        if (!string.IsNullOrWhiteSpace(request.VerificationUri))
        {
            context.Console.MarkupLine($"[dim]{request.VerificationUri} → Access tokens[/]");
        }

        context.Console.WriteLine();
        context.Console.MarkupLine("[dim]Waiting for approval…[/]");

        var interval = TimeSpan.FromSeconds(Math.Clamp(request.IntervalSeconds, 1, 30));
        var deadline = DateTimeOffset.UtcNow.AddSeconds(Math.Clamp(request.ExpiresInSeconds, 30, 1800));
        while (DateTimeOffset.UtcNow < deadline)
        {
            await Task.Delay(interval, cancellationToken);

            var poll = await http.PostAsJsonAsync(
                $"{origin}/api/auth/device/token",
                new DeviceTokenRequest(request.DeviceCode),
                CliJson.TypeInfo<DeviceTokenRequest>(),
                cancellationToken);
            var answer = poll.IsSuccessStatusCode
                ? await poll.Content.ReadFromJsonAsync(CliJson.TypeInfo<DeviceTokenResponse>(), cancellationToken)
                : null;

            switch (answer?.Status)
            {
                case "approved" when !string.IsNullOrWhiteSpace(answer.Token):
                    return answer.Token;
                case "denied":
                    context.Console.MarkupLine("[red]The request was denied.[/]");
                    return null;
                case "expired":
                    context.Console.MarkupLine("[red]The code expired before it was approved.[/]");
                    return null;
            }
        }

        context.Console.MarkupLine("[red]Timed out waiting for approval.[/]");
        return null;
    }

    private static async Task<SessionProbeResponse?> ProbeAsync(HttpClient http, string origin, string token, CancellationToken cancellationToken)
    {
        using var probe = new HttpRequestMessage(HttpMethod.Get, $"{origin}/api/auth/session");
        probe.Headers.Add("Authorization", $"Bearer {token}");
        var response = await http.SendAsync(probe, cancellationToken);
        return response.IsSuccessStatusCode
            ? await response.Content.ReadFromJsonAsync(CliJson.TypeInfo<SessionProbeResponse>(), cancellationToken)
            : null;
    }

    private static LoginOptions ParseOptions(string[] args)
    {
        var options = new LoginOptions();
        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--host":
                    options.Host = ReadValue(args, ref index, "--host");
                    break;
                case "--token":
                    options.Token = ReadValue(args, ref index, "--token");
                    break;
                case "--name":
                    options.Name = ReadValue(args, ref index, "--name");
                    break;
                case "--use":
                    options.Use = ReadValue(args, ref index, "--use");
                    break;
                case "--list":
                    options.List = true;
                    break;
                default:
                    throw new CommandUsageException($"Unknown option '{args[index]}'.", Usage);
            }
        }

        return options;
    }

    private static string ReadValue(string[] args, ref int index, string option)
    {
        if (index + 1 >= args.Length)
        {
            throw new CommandUsageException($"{option} requires a value.", Usage);
        }

        return args[++index];
    }

    private static string NormalizeOrigin(string host)
    {
        var value = host.Trim().TrimEnd('/');
        // A bare hostname is the common typo; assume HTTPS rather than silently sending a credential in
        // the clear.
        if (!value.Contains("://", StringComparison.Ordinal))
        {
            value = $"https://{value}";
        }

        return value;
    }

    private static string DefaultContextName(string origin)
        => Uri.TryCreate(origin, UriKind.Absolute, out var uri) ? uri.Host : "hosty";

    internal static string FormatUserCode(string userCode)
        => userCode.Length == 8 ? $"{userCode[..4]}-{userCode[4..]}" : userCode;

    private sealed class LoginOptions
    {
        public string? Host { get; set; }

        public string? Token { get; set; }

        public string? Name { get; set; }

        public string? Use { get; set; }

        public bool List { get; set; }
    }

    internal sealed record DeviceCodeRequest(string? Label);

    internal sealed record DeviceCodeResponse(
        string DeviceCode,
        string UserCode,
        string? VerificationUri,
        int IntervalSeconds,
        int ExpiresInSeconds);

    internal sealed record DeviceTokenRequest(string DeviceCode);

    internal sealed record DeviceTokenResponse(string Status, string? Token);

    internal sealed record SessionProbeResponse(bool Authenticated, SessionProbeUser? User, string? Kind);

    internal sealed record SessionProbeUser(string Id, string? Email, string? DisplayName, string Role);
}
