using Haas.Hosty.Initialization;
using Spectre.Console;

namespace Haas.Hosty.Cli.Commands;

internal sealed class InitCommand(CommandContext context)
{
    internal const string Usage = """
        Usage:
          hosty init                         Install Core, choose apps and register an administrator
          hosty init --yes                    Use recommended apps without prompting
          hosty init --apps <ID>[,..]         Select exactly these distribution apps
          hosty init --core-only              Initialize without runtime apps
          hosty init --review                 Review new choices after a failed initialization
          hosty init --no-open                Print the setup link without opening a browser
          hosty init --port <PORT>            Choose the initial Core port (otherwise automatic)
          hosty init --app-port <ID>:<SERVICE>:<KEY>=<PORT>
          hosty init --project <PATH>         Initialize an explicit source Core project

        Repeating init resumes this data root. Use hosty setup to add or remove apps afterwards.
        """;
    internal sealed record Options(string[]? Apps, bool Yes, bool NoOpen, int? Port,
        InitializationPort[] AppPorts, string? Project, bool Review);
    internal static Options Parse(string[] args)
    {
        string[]? apps = null;
        var yes = false; var noOpen = false; var review = false; int? port = null; string? project = null;
        var ports = new List<InitializationPort>();
        for (var i = 0; i < args.Length; i++)
        {
            string Value() => i + 1 < args.Length ? args[++i] : throw new CommandUsageException("Missing option value.", Usage);
            switch (args[i])
            {
                case "--yes": case "-y": yes = true; break;
                case "--review": review = true; break;
                case "--no-open": noOpen = true; break;
                case "--core-only": apps = []; break;
                case "--apps": apps = Value().Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries); break;
                case "--port": port = ParsePort(Value()); break;
                case "--project": project = Path.GetFullPath(Value()); break;
                case "--app-port":
                    var pair = Value().Split('=');
                    var keys = pair[0].Split(':');
                    if (pair.Length != 2 || keys.Length != 3 || keys.Any(string.IsNullOrWhiteSpace))
                        throw new CommandUsageException("Use --app-port appId:service:portKey=port.", Usage);
                    ports.Add(new(keys[0], keys[1], keys[2], ParsePort(pair[1]))); break;
                default: throw new CommandUsageException($"Unknown init option '{args[i]}'.", Usage);
            }
        }
        if (apps is not null && apps.Distinct(StringComparer.Ordinal).Count() != apps.Length)
            throw new CommandUsageException("Select each app only once.", Usage);
        return new(apps, yes, noOpen, port, ports.ToArray(), project, review);
    }
    private static int ParsePort(string value) => int.TryParse(value, out var port) && port is >= 1024 and <= 65535
        ? port : throw new CommandUsageException("Port must be from 1024 to 65535.", Usage);

    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args is ["--help"] or ["-h"] or ["help"]) { context.Console.WriteLine(Usage); return 0; }
        var options = Parse(args);
        var root = context.Environment.RootDirectory;
        Directory.CreateDirectory(Path.Combine(root, "core"));
        // Serialize local download/prompt sessions without holding the separate Core launch lock.
        using var initLock = new FileStream(Path.Combine(root, "core", "initialization.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        if (options.Project is null) await new CoreInstallationService(context).EnsureInstalledAsync();
        if (!InitializationFiles.HasHistory(root) || InitializationFiles.Requested(root)) InitializationFiles.Request(root);
        var startArgs = new List<string> { "start" };
        if (options.Project is not null) startArgs.AddRange(["--project", options.Project]);
        if (options.Port is not null) startArgs.AddRange(["--port", options.Port.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)]);
        var started = false;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            if (await new CoreCommand(context, initializing: true).ExecuteAsync(startArgs.ToArray()) == 0) { started = true; break; }
            if (!RetryableListenerCollision(root)) return 1;
            context.Console.WriteLine("The first automatic Core port was occupied during startup; retrying with another free port.");
        }
        if (!started) return 1;
        using var core = await CoreControlClient.TryCreateAsync(context) ?? throw new CoreNotRunningException();
        var status = await ReadAsync(core);
        if (options.Review && status.Phase != "failed")
            throw new CommandUsageException("--review is only for a failed initialization. Use hosty setup after completion.", Usage);
        if (status.Phase is "ready" or "existing") return await FinishAsync(core, status, options);
        InitializationRequest input;
        if (!options.Review && status.Request is { } accepted)
        {
            if (options.Apps is not null && !options.Apps.Order(StringComparer.Ordinal).SequenceEqual(accepted.Apps.Order(StringComparer.Ordinal)))
                throw new CommandUsageException("This root has an accepted selection. Resume it without --apps, then use hosty setup to change apps.", Usage);
            if (options.AppPorts.Length > 0 && !options.AppPorts.OrderBy(p => p.AppId).ThenBy(p => p.Service).ThenBy(p => p.PortKey)
                .SequenceEqual((accepted.Ports ?? []).OrderBy(p => p.AppId).ThenBy(p => p.Service).ThenBy(p => p.PortKey)))
                throw new CommandUsageException("Resume with the accepted app ports; they cannot change during replay.", Usage);
            input = accepted;
            context.Console.WriteLine("Resuming the saved initialization selection.");
        }
        else
        {
            var catalog = await core.GetAsync<SetupCommand.BootstrapStateResponse>("core/bootstrap")
                ?? throw new IOException("Core returned no distribution catalog.");
            if (catalog.Problems is { Count: > 0 }) throw new IOException(string.Join("; ", catalog.Problems));
            var entries = catalog.Apps ?? [];
            var selected = options.Apps ?? (options.Yes ? entries.Where(e => e.DefaultEnabled).Select(e => e.Id).ToArray() : Prompt(entries));
            var unknown = selected.FirstOrDefault(id => entries.All(e => e.Id != id));
            if (unknown is not null) throw new CommandUsageException($"Unknown distribution app '{unknown}'.", Usage);
            if (!selected.Contains("hosty.shell")) context.Console.WriteLine("Shell is optional. Manage this host through CLI/API; hosty setup can install Shell later.");
            context.Console.WriteLine($"Core: {status.CoreUrl}");
            context.Console.WriteLine($"Apps: {(selected.Length == 0 ? "Core only" : string.Join(", ", selected))}. App ports are assigned automatically unless explicitly set.");
            if (!options.Yes && options.Apps is null && !context.Console.Confirm("Install this selection?", true)) return 0;
            input = new(Guid.NewGuid().ToString("N"), selected, options.AppPorts);
        }
        status = await core.PostAsync<InitializationStatus>("core/initialization", input) ?? throw new IOException("Core returned no initialization status.");
        string? last = null;
        while (status.Phase is "pending" or "preparing")
        {
            var progress = string.Join("; ", status.Apps.Select(a => $"{a.Title}: {a.State}"));
            if (progress != last) { context.Console.WriteLine(progress); last = progress; }
            await Task.Delay(TimeSpan.FromSeconds(2));
            status = await ReadAsync(core);
        }
        if (status.Phase == "failed")
        {
            context.Error.WriteLine(status.Error ?? "Initialization failed.");
            context.Error.WriteLine("Completed work is preserved. Correct the reported problem and run hosty init again. To explicitly review different apps, ports or changed distribution inputs, use hosty init --review.");
            return 1;
        }
        return await FinishAsync(core, status, options);
    }
    private static bool RetryableListenerCollision(string root)
    {
        var listener = Path.Combine(root, "core", "initialization-listener.json");
        var log = Path.Combine(root, "core", "logs", "core.log");
        if (!File.Exists(listener) || !File.Exists(log)) return false;
        using var state = System.Text.Json.JsonDocument.Parse(File.ReadAllBytes(listener));
        return state.RootElement.TryGetProperty("automatic", out var automatic) && automatic.ValueKind == System.Text.Json.JsonValueKind.True
            && state.RootElement.TryGetProperty("ready", out var ready) && ready.ValueKind == System.Text.Json.JsonValueKind.False
            && File.ReadAllText(log).Contains("Hosty Core cannot bind ", StringComparison.Ordinal);
    }
    private string[] Prompt(IReadOnlyList<SetupCommand.BootstrapAppResponse> entries)
    {
        if (!context.Console.Profile.Capabilities.Interactive)
            throw new CommandUsageException("Interactive initialization needs a terminal. Use --yes, --apps or --core-only.", Usage);
        var prompt = new MultiSelectionPrompt<string>().Title("Choose apps to install alongside Core:").NotRequired().PageSize(10)
            .UseConverter(id => { var entry = entries.First(e => e.Id == id); return Markup.Escape(entry.Title)
                + (entry.DefaultEnabled ? " [green](Recommended)[/]" : "") + " — " + Markup.Escape(entry.Description ?? ""); });
        foreach (var entry in entries) { prompt.AddChoice(entry.Id); if (entry.DefaultEnabled) prompt.Select(entry.Id); }
        return context.Console.Prompt(prompt).ToArray();
    }
    private static async Task<InitializationStatus> ReadAsync(CoreControlClient core)
    {
        InitializationStatus status;
        try { status = await core.GetAsync<InitializationStatus>("core/initialization") ?? throw new IOException("Core returned no initialization status."); }
        catch (CoreControlException ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
        { throw new IOException("This running Core does not support initialization. Use hosty update explicitly, then restart the intended Core.", ex); }
        if (status.SchemaVersion != InitializationFiles.Schema) throw new IOException("This Core does not support this initialization contract. Use hosty update explicitly before retrying.");
        return status;
    }
    private async Task<int> FinishAsync(CoreControlClient core, InitializationStatus status, Options options)
    {
        if (status.RecoveryRequired)
        {
            context.Error.WriteLine("Existing accounts require recovery. Run hosty auth recovery-token with this data root.");
            return 1;
        }
        if (status.HasAdministrator)
        {
            var url = status.ShellUrl ?? status.CoreUrl + "/login";
            context.Console.WriteLine("This host is initialized:");
            context.Console.Profile.Out.Writer.WriteLine(url);
            context.Console.WriteLine("Use hosty setup to add or remove distribution apps.");
            if (!options.NoOpen) OpenCommand.TryOpen(url);
            return 0;
        }
        var token = await core.PostAsync<AuthCommand.AuthTokenResponse>("core/initialization/setup-link")
            ?? throw new IOException("Core returned no setup link.");
        context.Console.WriteLine("Apps are ready. Create the first administrator in your browser:");
        context.Console.Profile.Out.Writer.WriteLine(token.SetupUrl ?? "");
        context.Console.Profile.Out.Writer.WriteLine($"Setup token: {token.Token}");
        context.Console.WriteLine($"Expires: {token.ExpiresAt:O}. Run hosty init again for a fresh link.");
        if (!options.NoOpen && token.SetupUrl is { } setup) OpenCommand.TryOpen(setup);
        return 0;
    }
}
