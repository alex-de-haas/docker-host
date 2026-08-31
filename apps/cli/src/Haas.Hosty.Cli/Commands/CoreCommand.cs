namespace Haas.Hosty.Cli.Commands;

using Haas.Hosty.Cli.Configuration;
using System.Diagnostics;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using Spectre.Console;

internal sealed partial class CoreCommand(CommandContext context)
{
    [JsonSourceGenerationOptions(
        PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        NumberHandling = JsonNumberHandling.AllowReadingFromString)]
    [JsonSerializable(typeof(CoreStatusDocument))]
    internal partial class CoreJsonContext : JsonSerializerContext;

    private static readonly TimeSpan StartTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan HealthProbeTimeout = TimeSpan.FromSeconds(2);
    // Short deadline for control-plane probes (status/stop) so an unresponsive Core fails fast instead
    // of hanging the CLI. Shared with the one CoreControlClient stack — no second discovery/client copy.
    private static readonly TimeSpan ControlProbeTimeout = TimeSpan.FromSeconds(3);
    // Upper bound on waiting for a stopped Core to fully exit. Core's own shutdown stops runtime apps
    // under a 15s bound plus listener drain, so 30s leaves margin before we report a stuck process.
    private static readonly TimeSpan StopTimeout = TimeSpan.FromSeconds(30);

    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length == 0 || args is ["--help"] or ["-h"] or ["help"])
        {
            context.Console.WriteLine(Usage);
            return 0;
        }

        return args[0] switch
        {
            "start" => await StartAsync(args[1..]),
            "status" => await StatusAsync(args[1..]),
            "stop" => await StopAsync(args[1..]),
            "restart" => await RestartAsync(args[1..]),
            "logs" => await LogsAsync(args[1..]),
            _ => throw new CommandUsageException($"Unknown core command '{args[0]}'.", Usage),
        };
    }

    private async Task<int> StartAsync(string[] args)
    {
        var options = ParseStartOptions(args);
        Directory.CreateDirectory(context.Environment.RootDirectory);
        var settings = context.SettingsStore.Load();
        settings.Validate(context.Environment);
        var url = options.Url ?? BuildDefaultCoreUrl(settings);

        // Idempotent start: if a Core already answers /healthz on this URL, reuse it
        // instead of spawning a duplicate that would fail to bind the port and leave
        // the caller staring at a control-discovery timeout.
        if (await IsCoreHealthyAsync(url))
        {
            return ReportAlreadyRunning(url, await ReadCoreStatusAsync(suppressErrors: true));
        }

        CoreStartTarget target;
        try
        {
            target = await ResolveStartTargetAsync(options);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or UnauthorizedAccessException or PlatformNotSupportedException or OperationCanceledException)
        {
            context.Error.MarkupLine($"[red]Hosty Core bootstrap failed:[/] {Markup.Escape(ex.Message)}");
            return 1;
        }

        if (options.Foreground)
        {
            var process = StartForeground(target, url, settings);
            context.Console.MarkupLine($"[green]Hosty Core starting.[/] PID {process.Id}, URL {Markup.Escape(url)}");
            await process.WaitForExitAsync();
            return process.ExitCode;
        }

        var logPath = StartBackground(target, url, settings);
        context.Console.MarkupLine($"[green]Hosty Core starting.[/] URL {Markup.Escape(url)}");
        context.Console.MarkupLine($"[grey]Log:[/] {Markup.Escape(logPath)}");

        var status = await WaitForStatusAsync();
        if (status is null)
        {
            context.Error.MarkupLine("[yellow]Hosty Core process started, but local control discovery was not ready before the timeout.[/]");
            context.Error.MarkupLine($"[grey]Check status with [white]hosty core status[/].[/]");
            return 1;
        }

        RenderStatus(status);
        return 0;
    }

    private async Task<CoreStartTarget> ResolveStartTargetAsync(StartOptions options)
    {
        if (options.ProjectPath is not null)
        {
            if (string.IsNullOrWhiteSpace(options.ProjectPath))
            {
                throw new CommandUsageException("--project requires a non-empty path.", Usage);
            }

            var projectPath = Path.GetFullPath(options.ProjectPath);
            if (!File.Exists(projectPath))
            {
                throw new CommandUsageException($"Hosty Core project was not found: {projectPath}", Usage);
            }

            return CoreStartTarget.FromProject(projectPath);
        }

        var installation = await new CoreInstallationService(context).EnsureInstalledAsync();
        return CoreStartTarget.FromExecutable(installation.ExecutablePath);
    }

    // Both background paths start Core with its stdout redirected into core.log, and a `>` redirect
    // truncates. That erased exactly the run worth reading: a crash is followed by a restart, and the
    // restart wipes the log of the crash — including a restart the operator triggers from Shell, or one
    // a Core update performs on its own. Rotating first keeps the previous runs (L-L3 in the 2026-07-05
    // review).
    //
    // Best-effort by design: a generation that cannot be moved — a stale Windows handle on the file,
    // the failure mode WindowsProcessControl exists for — must not stop Core from starting. The worst
    // case degrades to today's behavior for one start.
    internal static void RotateCoreLog(string logPath, int keep = 3)
    {
        try
        {
            if (!File.Exists(logPath))
            {
                return;
            }

            var oldest = $"{logPath}.{keep}";
            if (File.Exists(oldest))
            {
                File.Delete(oldest);
            }

            for (var generation = keep - 1; generation >= 1; generation--)
            {
                var from = $"{logPath}.{generation}";
                if (File.Exists(from))
                {
                    File.Move(from, $"{logPath}.{generation + 1}", overwrite: true);
                }
            }

            File.Move(logPath, $"{logPath}.1", overwrite: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private Process StartForeground(CoreStartTarget target, string url, LaunchSettings settings)
    {
        var startInfo = CreateCoreStartInfo(target, url, settings);
        startInfo.CreateNoWindow = false;
        return Process.Start(startInfo) ?? throw new InvalidOperationException("Unable to start Hosty Core process.");
    }

    private string StartBackground(CoreStartTarget target, string url, LaunchSettings settings)
    {
        var logDirectory = Path.Combine(context.Environment.RootDirectory, "core", "logs");
        Directory.CreateDirectory(logDirectory);
        var logPath = Path.Combine(logDirectory, "core.log");
        RotateCoreLog(logPath);

        if (OperatingSystem.IsWindows())
        {
            var windowsStartInfo = CreateWindowsBackgroundStartInfo(target, url, settings, logPath);
            using var windowsProcess = Process.Start(windowsStartInfo) ??
                throw new InvalidOperationException("Unable to start Hosty Core process.");
            return logPath;
        }

        var environment = BuildCoreEnvironment(url, settings)
            .Select(pair => $"{pair.Key}={ShellQuote(pair.Value)}");
        var command = string.Join(" ", [
            .. environment,
            "nohup",
            .. target.GetShellCommand(),
            ">",
            ShellQuote(logPath),
            "2>&1",
            "&",
        ]);

        var startInfo = new ProcessStartInfo
        {
            FileName = "/bin/sh",
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = target.WorkingDirectory,
        };
        startInfo.ArgumentList.Add("-c");
        startInfo.ArgumentList.Add(command);

        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("Unable to start Hosty Core process.");
        process.WaitForExit();
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"Unable to launch Hosty Core background process. Exit code {process.ExitCode}.");
        }

        return logPath;
    }

    private ProcessStartInfo CreateWindowsBackgroundStartInfo(CoreStartTarget target, string url, LaunchSettings settings, string logPath)
    {
        var command = string.Join(" ", [
            .. target.GetCmdShellCommand(),
            ">",
            CmdQuote(logPath),
            "2>&1",
        ]);

        var startInfo = new ProcessStartInfo
        {
            FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe",
            Arguments = $"/d /s /c \"{command}\"",
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = target.WorkingDirectory,
        };

        foreach (var pair in BuildCoreEnvironment(url, settings))
        {
            startInfo.Environment[pair.Key] = pair.Value;
        }

        return startInfo;
    }

    private ProcessStartInfo CreateCoreStartInfo(CoreStartTarget target, string url, LaunchSettings settings)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = target.FileName,
            UseShellExecute = false,
            WorkingDirectory = target.WorkingDirectory,
        };
        foreach (var argument in target.Arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        foreach (var pair in BuildCoreEnvironment(url, settings))
        {
            startInfo.Environment[pair.Key] = pair.Value;
        }

        return startInfo;
    }

    internal IReadOnlyDictionary<string, string> BuildCoreEnvironment(string url, LaunchSettings settings)
    {
        var environment = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [LaunchSettingDefinitions.HostyDataRoot] = settings.ResolveHostDataRoot(context.Environment),
            [LaunchSettingDefinitions.HostyCorePort] = ResolveCorePort(url, settings.HostyCorePort),
            ["HOSTY_CORE_URL"] = url,
            ["ASPNETCORE_URLS"] = url,
        };

        AddOptional(environment, LaunchSettingDefinitions.HostyCorePublicOrigin, settings.HostyCorePublicOrigin);
        // Hand Core the path to this managed CLI so its admin restart endpoint (used by the Shell platform
        // panel) can spawn `hosty core restart --keep-apps` to light-restart Core without an external
        // supervisor. Only when we are the installed `hosty` binary — a source/dev CLI (dotnet host) has
        // no restartable managed path, and Core falls back to a PATH lookup.
        if (Environment.ProcessPath is { } cliPath &&
            SelfUpdateService.IsManagedExecutableName(Path.GetFileName(cliPath)))
        {
            environment["HOSTY_CLI_PATH"] = cliPath;
        }
        // Manifest locations resolve from Core's release-owned distribution list, and which apps
        // bootstrap is the bootstrap-choices file's job (`hosty setup`). The runtime profile of a
        // system app (Shell, Telemetry, Marketplace) is a normal per-app choice: the manifest default
        // on first install, switchable afterwards with `hosty apps switch-runtime` — not a launch setting.
        return environment;
    }

    private static string BuildDefaultCoreUrl(LaunchSettings settings)
        => $"http://localhost:{settings.HostyCorePort}";

    private static string ResolveCorePort(string url, string fallback)
        => Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Port > 0
            ? uri.Port.ToString(System.Globalization.CultureInfo.InvariantCulture)
            : fallback;

    private static void AddOptional(IDictionary<string, string> environment, string key, string value)
    {
        if (!string.IsNullOrWhiteSpace(value))
        {
            environment[key] = value;
        }
    }


    private async Task<int> StatusAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("core status does not accept arguments.", Usage);
        }

        CoreStatusDocument? status;
        try
        {
            status = await ReadCoreStatusAsync();
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException or JsonException)
        {
            context.Error.MarkupLine($"[red]Unable to reach Hosty Core:[/] {Markup.Escape(ex.Message)}");
            return 1;
        }

        if (status is null)
        {
            context.Error.MarkupLine("[yellow]Hosty Core is not running or local control discovery is unavailable.[/]");
            context.Error.MarkupLine($"[grey]Discovery path:[/] {Markup.Escape(GetControlDiscoveryPath())}");
            return 1;
        }

        RenderStatus(status);
        return 0;
    }

    private enum StopOutcome
    {
        NotRunning,
        Stopped,
        TimedOut,
        Failed,
    }

    private async Task<int> StopAsync(string[] args)
    {
        var keepApps = ParseKeepAppsOnly(args);
        switch (await StopCoreAsync(keepApps))
        {
            case StopOutcome.NotRunning:
                context.Error.MarkupLine("[yellow]Hosty Core is not running or local control discovery is unavailable.[/]");
                return 1;
            case StopOutcome.Stopped:
                context.Console.MarkupLine("[green]Hosty Core stopped.[/]");
                return 0;
            case StopOutcome.TimedOut:
                context.Error.MarkupLine("[yellow]Hosty Core did not fully stop within the timeout; it may still be shutting down.[/]");
                context.Error.MarkupLine("[grey]Check it with [white]hosty core status[/].[/]");
                return 1;
            default:
                return 1;
        }
    }

    // Requests a stop and waits for the Core process to actually exit. The /core/stop call only
    // signals shutdown (StopApplication) and returns immediately, so without this wait a caller —
    // notably `restart`/`update` — would race the dying Core: start a new one while the old still
    // holds the port, or have the old Core's shutdown delete the new Core's freshly-written
    // discovery file. Error messages are printed here; the caller maps the outcome to an exit code.
    private async Task<StopOutcome> StopCoreAsync(bool keepApps = false)
    {
        var core = await CoreControlClient.TryCreateAsync(context, probeTimeout: ControlProbeTimeout, operationTimeout: StopTimeout);
        if (core is null)
        {
            return StopOutcome.NotRunning;
        }

        // The stop request returns immediately but the process can take several seconds to fully
        // exit, so show a spinner while we wait. Outcome messages are printed by the caller after the
        // spinner clears; errors go to the separate stderr console, which stays safe under the live
        // status display.
        using (core)
        {
            return await CommandStatus.RunAsync(
                context,
                keepApps ? "Stopping Hosty Core (keeping apps running)…" : "Stopping Hosty Core…",
                () => RequestStopAndWaitAsync(core, keepApps));
        }
    }

    private async Task<StopOutcome> RequestStopAndWaitAsync(CoreControlClient core, bool keepApps)
    {
        try
        {
            // keepApps=true is the "light stop": Core exits without stopping its app containers, so a
            // Core-only restart/update leaves running apps untouched (they are re-adopted on next boot).
            await core.PostAsync(keepApps ? "core/stop?keepApps=true" : "core/stop");
        }
        catch (CoreControlException ex) when (ex.StatusCode == HttpStatusCode.Unauthorized)
        {
            context.Error.MarkupLine("[red]Unable to stop Hosty Core:[/] local control secret was rejected.");
            context.Error.MarkupLine($"[grey]This usually means the control discovery file is stale or belongs to another Core process: {Markup.Escape(GetControlDiscoveryPath())}[/]");
            context.Error.MarkupLine("[grey]Run `hosty core status` to verify the active Core. If no matching Core is running, remove the stale discovery file and start Core again.[/]");
            return StopOutcome.Failed;
        }
        catch (CoreControlException ex)
        {
            context.Error.MarkupLine($"[red]Unable to stop Hosty Core:[/] HTTP {(int)ex.StatusCode}: {Markup.Escape(ex.ResponseBody)}");
            return StopOutcome.Failed;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException or CoreControlTimeoutException)
        {
            context.Error.MarkupLine($"[red]Unable to reach Hosty Core:[/] {Markup.Escape(ex.Message)}");
            return StopOutcome.Failed;
        }

        return await WaitForCoreFullyStoppedAsync(core.CoreProcessId, core.ControlBaseUrl)
            ? StopOutcome.Stopped
            : StopOutcome.TimedOut;
    }

    private async Task<int> RestartAsync(string[] args)
    {
        // --keep-apps is a restart/stop concern, not a start option, so pull it out before the rest is
        // validated as start options and forwarded to StartAsync.
        var (keepApps, startArgs) = ExtractKeepAppsFlag(args);

        // Validate start options up front so a bad flag fails before we stop the running Core.
        _ = ParseStartOptions(startArgs);

        // StopCoreAsync waits for the old process to fully exit (port released, discovery file
        // removed), so the start below binds cleanly and cannot have its discovery clobbered by the
        // old Core's shutdown. NotRunning is fine — there is simply nothing to stop. With --keep-apps
        // the stop leaves the app containers running and the start below re-adopts them.
        switch (await StopCoreAsync(keepApps))
        {
            case StopOutcome.NotRunning:
            case StopOutcome.Stopped:
                break;
            case StopOutcome.TimedOut:
                context.Error.MarkupLine("[red]Hosty Core did not fully stop within the timeout; restart aborted.[/]");
                context.Error.MarkupLine("[grey]Check it with [white]hosty core status[/] and retry once it has stopped.[/]");
                return 1;
            default:
                context.Error.MarkupLine("[red]Hosty Core stop failed; restart aborted.[/]");
                return 1;
        }

        return await StartAsync(startArgs);
    }

    internal enum CoreUpdateStopOutcome
    {
        // A running Core was stopped (keeping apps) — the caller should restart it on the new binary.
        StoppedRunning,
        // No Core was running — nothing to stop; the caller leaves it stopped.
        NotRunning,
        // A running Core could not be stopped in time — on Windows the executable replace may then fail.
        Failed,
    }

    // Light restart for `hosty update`: stop Core WITHOUT stopping its apps so the executable can be
    // replaced (and, on Windows, unlocked) without disturbing running containers. The apps are re-adopted
    // when Core starts again.
    internal async Task<CoreUpdateStopOutcome> StopForUpdateAsync()
        => await StopCoreAsync(keepApps: true) switch
        {
            StopOutcome.Stopped => CoreUpdateStopOutcome.StoppedRunning,
            StopOutcome.NotRunning => CoreUpdateStopOutcome.NotRunning,
            _ => CoreUpdateStopOutcome.Failed,
        };

    // Starts the installed Core (no start options) after an update replaced its executable. The new
    // process re-adopts the still-running app containers left by StopForUpdateAsync.
    internal Task<int> StartInstalledAsync() => StartAsync([]);

    private static bool ParseKeepAppsOnly(string[] args)
    {
        var keepApps = false;
        foreach (var arg in args)
        {
            if (arg == "--keep-apps")
            {
                keepApps = true;
            }
            else
            {
                throw new CommandUsageException($"Unknown core stop option '{arg}'.", Usage);
            }
        }

        return keepApps;
    }

    private static (bool KeepApps, string[] Remaining) ExtractKeepAppsFlag(string[] args)
    {
        var keepApps = false;
        var rest = new List<string>(args.Length);
        foreach (var arg in args)
        {
            if (arg == "--keep-apps")
            {
                keepApps = true;
            }
            else
            {
                rest.Add(arg);
            }
        }

        return (keepApps, rest.ToArray());
    }

    private Task<int> LogsAsync(string[] args)
    {
        var tail = 200;
        for (var index = 0; index < args.Length; index++)
        {
            if (args[index] == "--tail")
            {
                if (index + 1 >= args.Length || !int.TryParse(args[index + 1], out tail) || tail < 1)
                {
                    throw new CommandUsageException("--tail must be a positive integer.", Usage);
                }

                index++;
            }
            else
            {
                throw new CommandUsageException($"Unknown core logs option '{args[index]}'.", Usage);
            }
        }

        var logPath = Path.Combine(context.Environment.RootDirectory, "core", "logs", "core.log");
        if (!File.Exists(logPath))
        {
            context.Error.MarkupLine($"[yellow]Hosty Core log was not found.[/]");
            context.Error.MarkupLine($"[grey]Log:[/] {Markup.Escape(logPath)}");
            return Task.FromResult(1);
        }

        foreach (var line in File.ReadLines(logPath).TakeLast(tail))
        {
            context.Console.WriteLine(line);
        }

        return Task.FromResult(0);
    }

    private async Task<bool> IsCoreHealthyAsync(string url)
    {
        try
        {
            using var httpClient = new HttpClient { Timeout = HealthProbeTimeout };
            using var response = await httpClient.GetAsync($"{url.TrimEnd('/')}/healthz");
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException
            or InvalidOperationException or UriFormatException)
        {
            // A malformed --url (UriFormatException/InvalidOperationException) is treated as
            // "not healthy" so the probe can never crash the CLI; the start path handles the
            // bad URL from there.
            return false;
        }
    }

    // Waits for the stopped Core to fully exit. Prefers the recorded PID (the real "process gone"
    // signal — port released and discovery removed); falls back to /healthz going dark for an older
    // Core whose discovery file carries no PID.
    private async Task<bool> WaitForCoreFullyStoppedAsync(int? processId, string controlBaseUrl)
    {
        if (processId is int pid && pid > 0)
        {
            return await ProcessLiveness.WaitForExitAsync(pid, StopTimeout);
        }

        // Same budget as the PID path so a no-PID Core is not declared timed-out 15s early.
        return TryGetOrigin(controlBaseUrl) is { } origin
            ? await WaitForCoreStoppedAsync(origin, StopTimeout)
            : true;
    }

    private static string? TryGetOrigin(string controlBaseUrl)
        => Uri.TryCreate(controlBaseUrl, UriKind.Absolute, out var uri)
            ? uri.GetLeftPart(UriPartial.Authority)
            : null;

    // Returns true once the Core at <url> stops answering /healthz, or false if it is still
    // responding when the timeout elapses.
    private async Task<bool> WaitForCoreStoppedAsync(string url, TimeSpan timeout)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (!await IsCoreHealthyAsync(url))
            {
                return true;
            }

            await Task.Delay(250);
        }

        return !await IsCoreHealthyAsync(url);
    }

    private int ReportAlreadyRunning(string url, CoreStatusDocument? status)
    {
        if (status is not null)
        {
            context.Console.MarkupLine("[green]Hosty Core is already running.[/]");
            RenderStatus(status);
            return 0;
        }

        context.Console.MarkupLine($"[green]Hosty Core is already running.[/] URL {Markup.Escape(url)}");
        context.Console.MarkupLine("[grey]Local control discovery is unavailable; run [white]hosty core restart[/] if you need CLI control.[/]");
        return 0;
    }

    private async Task<CoreStatusDocument?> WaitForStatusAsync()
    {
        var deadline = DateTimeOffset.UtcNow + StartTimeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            var status = await ReadCoreStatusAsync(suppressErrors: true);
            if (status is not null)
            {
                return status;
            }

            await Task.Delay(500);
        }

        return null;
    }

    private async Task<CoreStatusDocument?> ReadCoreStatusAsync(bool suppressErrors = false)
    {
        // One shared discovery+client stack (CoreControlClient) — it already handles the mid-write file,
        // stale-PID self-clean, and required headers, so CoreCommand no longer keeps its own copy (L-M4).
        using var core = await CoreControlClient.TryCreateAsync(context, probeTimeout: ControlProbeTimeout);
        if (core is null)
        {
            return null;
        }

        try
        {
            return await core.GetAsync<CoreStatusDocument>("core/status");
        }
        catch (Exception ex) when (suppressErrors &&
            ex is CoreControlException or CoreControlTimeoutException or HttpRequestException or IOException or TaskCanceledException or JsonException)
        {
            return null;
        }
    }

    private string GetControlDiscoveryPath()
        => Path.Combine(context.Environment.RootDirectory, "core", "run", "control.json");

    private static StartOptions ParseStartOptions(string[] args)
    {
        string? projectPath = null;
        string? url = null;
        var foreground = false;

        for (var index = 0; index < args.Length; index++)
        {
            var arg = args[index];
            switch (arg)
            {
                case "--foreground":
                    foreground = true;
                    break;
                case "--project":
                    projectPath = RequireOptionValue(args, ref index, "--project");
                    break;
                case "--url":
                    url = RequireOptionValue(args, ref index, "--url");
                    break;
                default:
                    throw new CommandUsageException($"Unknown core start option '{arg}'.", Usage);
            }
        }

        return new StartOptions(projectPath, url, foreground);
    }

    private static string RequireOptionValue(string[] args, ref int index, string option)
    {
        if (index + 1 >= args.Length)
        {
            throw new CommandUsageException($"{option} requires a value.", Usage);
        }

        index++;
        return args[index];
    }

    private static string ShellQuote(string value)
        => $"'{value.Replace("'", "'\"'\"'", StringComparison.Ordinal)}'";

    private static string CmdQuote(string value)
        => $"\"{value}\"";

    private void RenderStatus(CoreStatusDocument status)
    {
        var table = ConsoleUi.CreateDetail()
            .Field("Status", ConsoleUi.State(status.Status ?? "unknown"))
            .Field("Component", Markup.Escape(status.Component ?? "hosty-core"))
            .Field("Listen URL", Markup.Escape(status.ListenUrl ?? ""));
        if (status.CorePort > 0)
        {
            table.Field("Core port", status.CorePort.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        table
            .Field("Data root", Markup.Escape(status.DataRoot ?? ""))
            .Field("Core origin", Markup.Escape(status.CorePublicOrigin ?? "not configured"))
            // Core resolves this from Shell's app record, so a blank means Shell is not installed at all
            // — not that someone forgot to configure it. "not configured" would send the operator looking
            // for a setting that no longer exists. Blank-checked rather than null-checked: Core only ever
            // sends a normalized origin or null, but this is parsing a wire response, and an empty string
            // slipping through would render an empty cell — the one outcome this line exists to avoid.
            .Field("Shell origin", string.IsNullOrWhiteSpace(status.ShellPublicOrigin)
                ? "no Shell installed"
                : Markup.Escape(status.ShellPublicOrigin));
        context.Console.Write(table);

        foreach (var warning in status.Warnings ?? [])
        {
            context.Error.MarkupLine($"[yellow]Warning:[/] {Markup.Escape(warning)}");
        }
    }

    internal sealed record StartOptions(string? ProjectPath, string? Url, bool Foreground);

    internal sealed record CoreStartTarget(
        string FileName,
        string WorkingDirectory,
        IReadOnlyList<string> Arguments)
    {
        public static CoreStartTarget FromProject(string projectPath)
            => new(
                "dotnet",
                Path.GetDirectoryName(projectPath) ?? Directory.GetCurrentDirectory(),
                ["run", "--project", projectPath, "--no-launch-profile"]);

        public static CoreStartTarget FromExecutable(string executablePath)
            => new(
                executablePath,
                Path.GetDirectoryName(executablePath) ?? Directory.GetCurrentDirectory(),
                []);

        public IEnumerable<string> GetShellCommand()
        {
            yield return ShellQuote(FileName);
            foreach (var argument in Arguments)
            {
                yield return ShellQuote(argument);
            }
        }

        public IEnumerable<string> GetCmdShellCommand()
        {
            yield return CmdQuote(FileName);
            foreach (var argument in Arguments)
            {
                yield return CmdQuote(argument);
            }
        }
    }

    internal sealed record CoreStatusDocument(
        string? Status,
        string? Component,
        string? DataRoot,
        string? ListenUrl,
        int CorePort,
        string? CorePublicOrigin,
        string? ShellPublicOrigin,
        IReadOnlyList<string> Warnings);

    private const string Usage = """
        hosty core

        Usage:
          hosty core <command> [options]

        Commands:
          start [--project <csproj-path>] [--url <url>] [--foreground]
          status
          stop [--keep-apps]
          restart [--keep-apps] [--project <csproj-path>] [--url <url>] [--foreground]
          logs [--tail <count>]

        Description:
          Manages the installed Hosty Core process. Pass --project for explicit source mode.
          --keep-apps stops/restarts Core WITHOUT stopping running apps (light restart), leaving
          their containers up to be re-adopted when Core starts again.
        """;
}
