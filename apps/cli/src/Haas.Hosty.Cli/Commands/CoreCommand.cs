namespace Haas.Hosty.Cli.Commands;

using Haas.Hosty.Cli.Configuration;
using System.Diagnostics;
using System.Net;
using System.Text.Json;
using Spectre.Console;

internal sealed class CoreCommand(CommandContext context)
{
    private static readonly TimeSpan StartTimeout = TimeSpan.FromSeconds(15);

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

        CoreStartTarget target;
        try
        {
            target = await ResolveStartTargetAsync(options);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or UnauthorizedAccessException or PlatformNotSupportedException or OperationCanceledException)
        {
            context.Console.MarkupLine($"[red]Hosty Core bootstrap failed:[/] {Markup.Escape(ex.Message)}");
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
            context.Console.MarkupLine("[yellow]Hosty Core process started, but local control discovery was not ready before the timeout.[/]");
            context.Console.MarkupLine($"[grey]Check status with [white]hosty core status[/].[/]");
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

    private IReadOnlyDictionary<string, string> BuildCoreEnvironment(string url, LaunchSettings settings)
    {
        var environment = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [LaunchSettingDefinitions.HostyDataRoot] = settings.ResolveHostDataRoot(context.Environment),
            [LaunchSettingDefinitions.HostyCorePort] = ResolveCorePort(url, settings.HostyCorePort),
            [LaunchSettingDefinitions.HostyShellPort] = settings.HostyShellPort,
            ["HOSTY_CORE_URL"] = url,
            ["ASPNETCORE_URLS"] = url,
        };

        AddOptional(environment, LaunchSettingDefinitions.HostyCorePublicOrigin, settings.HostyCorePublicOrigin);
        AddOptional(environment, LaunchSettingDefinitions.HostyShellPublicOrigin, settings.HostyShellPublicOrigin);
        AddOptional(environment, LaunchSettingDefinitions.HostyShellManifestPath, settings.ResolveHostyShellManifestPath(context.Environment));
        AddOptional(environment, LaunchSettingDefinitions.HostyShellBootstrapRuntime, settings.HostyShellBootstrapRuntime);
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
            context.Console.MarkupLine($"[red]Unable to reach Hosty Core:[/] {Markup.Escape(ex.Message)}");
            return 1;
        }

        if (status is null)
        {
            context.Console.MarkupLine("[yellow]Hosty Core is not running or local control discovery is unavailable.[/]");
            context.Console.MarkupLine($"[grey]Discovery path:[/] {Markup.Escape(GetControlDiscoveryPath())}");
            return 1;
        }

        RenderStatus(status);
        return 0;
    }

    private async Task<int> StopAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("core stop does not accept arguments.", Usage);
        }

        var discovery = await ReadControlDiscoveryAsync();
        if (discovery is null)
        {
            context.Console.MarkupLine("[yellow]Hosty Core is not running or local control discovery is unavailable.[/]");
            return 1;
        }

        using var httpClient = CreateControlClient(discovery);
        HttpResponseMessage response;
        try
        {
            response = await httpClient.PostAsync($"{discovery.ControlBaseUrl.TrimEnd('/')}/core/stop", content: null);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException)
        {
            context.Console.MarkupLine($"[red]Unable to reach Hosty Core:[/] {Markup.Escape(ex.Message)}");
            return 1;
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
            {
                var body = await response.Content.ReadAsStringAsync();
                if (response.StatusCode == HttpStatusCode.Unauthorized)
                {
                    context.Console.MarkupLine("[red]Unable to stop Hosty Core:[/] local control secret was rejected.");
                    context.Console.MarkupLine($"[grey]This usually means the control discovery file is stale or belongs to another Core process: {Markup.Escape(GetControlDiscoveryPath())}[/]");
                    context.Console.MarkupLine("[grey]Run `hosty core status` to verify the active Core. If no matching Core is running, remove the stale discovery file and start Core again.[/]");
                    return 1;
                }

                context.Console.MarkupLine($"[red]Unable to stop Hosty Core:[/] HTTP {(int)response.StatusCode}: {Markup.Escape(body)}");
                return 1;
            }

            context.Console.MarkupLine("[green]Hosty Core stop requested.[/]");
            return 0;
        }
    }

    private async Task<int> RestartAsync(string[] args)
    {
        var stopResult = await StopAsync([]);
        if (stopResult == 0)
        {
            await Task.Delay(750);
        }

        return await StartAsync(args);
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
            context.Console.MarkupLine($"[yellow]Hosty Core log was not found.[/]");
            context.Console.MarkupLine($"[grey]Log:[/] {Markup.Escape(logPath)}");
            return Task.FromResult(1);
        }

        foreach (var line in File.ReadLines(logPath).TakeLast(tail))
        {
            context.Console.WriteLine(line);
        }

        return Task.FromResult(0);
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
        var discovery = await ReadControlDiscoveryAsync();
        if (discovery is null)
        {
            return null;
        }

        try
        {
            using var httpClient = CreateControlClient(discovery);
            using var response = await httpClient.GetAsync($"{discovery.ControlBaseUrl.TrimEnd('/')}/core/status");
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            await using var stream = await response.Content.ReadAsStreamAsync();
            return await JsonSerializer.DeserializeAsync<CoreStatusDocument>(stream, JsonOptions);
        }
        catch (Exception ex) when (suppressErrors && ex is HttpRequestException or IOException or TaskCanceledException or JsonException)
        {
            return null;
        }
    }

    private HttpClient CreateControlClient(ControlDiscoveryDocument discovery)
    {
        var httpClient = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(3),
        };

        foreach (var header in discovery.RequiredHeaders)
        {
            httpClient.DefaultRequestHeaders.TryAddWithoutValidation(header.Key, header.Value);
        }

        return httpClient;
    }

    private async Task<ControlDiscoveryDocument?> ReadControlDiscoveryAsync()
    {
        var path = GetControlDiscoveryPath();
        if (!File.Exists(path))
        {
            return null;
        }

        await using var stream = File.OpenRead(path);
        return await JsonSerializer.DeserializeAsync<ControlDiscoveryDocument>(stream, JsonOptions);
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
        var table = new Table();
        table.AddColumn("Field");
        table.AddColumn("Value");
        table.AddRow("Status", Markup.Escape(status.Status ?? "unknown"));
        table.AddRow("Component", Markup.Escape(status.Component ?? "hosty-core"));
        table.AddRow("Listen URL", Markup.Escape(status.ListenUrl ?? ""));
        if (status.CorePort > 0)
        {
            table.AddRow("Core port", status.CorePort.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        if (status.ShellPort > 0)
        {
            table.AddRow("Shell port", status.ShellPort.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        table.AddRow("Data root", Markup.Escape(status.DataRoot ?? ""));
        table.AddRow("Core origin", Markup.Escape(status.CorePublicOrigin ?? "not configured"));
        table.AddRow("Shell origin", Markup.Escape(status.ShellPublicOrigin ?? "not configured"));
        context.Console.Write(table);

        foreach (var warning in status.Warnings ?? [])
        {
            context.Console.MarkupLine($"[yellow]Warning:[/] {Markup.Escape(warning)}");
        }
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private sealed record StartOptions(string? ProjectPath, string? Url, bool Foreground);

    private sealed record CoreStartTarget(
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

    private sealed record ControlDiscoveryDocument(
        string ControlBaseUrl,
        IReadOnlyDictionary<string, string> RequiredHeaders);

    private sealed record CoreStatusDocument(
        string? Status,
        string? Component,
        string? DataRoot,
        string? ListenUrl,
        int CorePort,
        int ShellPort,
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
          stop
          restart [--project <csproj-path>] [--url <url>] [--foreground]
          logs [--tail <count>]

        Description:
          Manages the installed Hosty Core process. Pass --project for explicit source mode.
        """;
}
