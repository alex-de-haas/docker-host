namespace Haas.DockerHost.Cli.Commands;

using System.Text.Json;
using Haas.DockerHost.Cli.Configuration;
using Spectre.Console;

internal sealed class AppsCommand(CommandContext context)
{
    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length == 0 || args is ["--help"] or ["-h"] or ["help"])
        {
            context.Console.WriteLine(Usage);
            return 0;
        }

        try
        {
            return args[0] switch
            {
                "list" => await ListAsync(args[1..]),
                "install" => await InstallAsync(args[1..]),
                "autostart" => await AutostartAsync(args[1..]),
                "start" => await LifecycleActionAsync("start", args[1..]),
                "stop" => await LifecycleActionAsync("stop", args[1..]),
                "restart" => await LifecycleActionAsync("restart", args[1..]),
                "update-plan" => await UpdatePlanAsync(args[1..]),
                "update" => await UpdateAsync(args[1..]),
                "switch-runtime-plan" => await SwitchRuntimePlanAsync(args[1..]),
                "switch-runtime" => await SwitchRuntimeAsync(args[1..]),
                "remove" => await RemoveAsync(args[1..]),
                "backup" => await BackupAsync(args[1..]),
                "backups" => await BackupsAsync(args[1..]),
                "restore" => await RestoreAsync(args[1..]),
                "logs" => await LogsAsync(args[1..]),
                "health" => await HealthAsync(args[1..]),
                "source" => await SourceAsync(args[1..]),
                "source-resolve" => await SourceResolveAsync(args[1..]),
                "source-override" => await SourceOverrideAsync(args[1..]),
                "source-clear-override" => await SourceClearOverrideAsync(args[1..]),
                "source-cleanup-plan" => await SourceCleanupPlanAsync(args[1..]),
                "source-cleanup" => await SourceCleanupAsync(args[1..]),
                "identity" => await IdentityAsync(args[1..]),
                "open" => await OpenAsync(args[1..]),
                _ => throw new CommandUsageException($"Unknown apps command '{args[0]}'.", Usage),
            };
        }
        catch (CoreControlException ex)
        {
            context.Console.MarkupLine($"[red]Hosty Core API failed:[/] {Markup.Escape(ex.Message)}");
            if (!string.IsNullOrWhiteSpace(ex.ResponseBody))
            {
                context.Console.MarkupLine($"[grey]Response:[/] {Markup.Escape(ex.ResponseBody)}");
            }

            return 1;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException)
        {
            context.Console.MarkupLine($"[red]Unable to reach Hosty Core:[/] {Markup.Escape(ex.Message)}");
            return 1;
        }
    }

    private async Task<int> ListAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("apps list does not accept arguments.", Usage);
        }

        using var core = await OpenCoreAsync();
        var response = await core.GetAsync<AppsResponse>("apps");
        RenderApps(response?.Apps ?? []);
        return 0;
    }

    private async Task<int> InstallAsync(string[] args)
    {
        var options = ParseInstallOptions(args);
        using var core = await OpenCoreAsync();
        var response = await core.PostAsync<AppLifecycleResponse>("apps/install", new AppInstallRequest(
            ManifestPath: options.ManifestPath,
            SelectedRuntime: options.SelectedRuntime,
            SelectedChannel: options.SelectedChannel,
            System: options.System,
            Autostart: options.Autostart));
        RenderLifecycle(response);
        return 0;
    }

    private async Task<int> AutostartAsync(string[] args)
    {
        var options = ParseAutostartOptions(args);
        using var core = await OpenCoreAsync();
        var response = await core.PostAsync<AppLifecycleResponse>(
            $"apps/{Uri.EscapeDataString(options.AppId)}/autostart",
            new AppAutostartRequest(options.Autostart));
        RenderLifecycle(response);
        return 0;
    }

    private async Task<int> LifecycleActionAsync(string action, string[] args)
    {
        var appId = RequireSingleAppId(args, $"apps {action}");
        using var core = await OpenCoreAsync();
        var response = await core.PostAsync<AppLifecycleResponse>($"apps/{Uri.EscapeDataString(appId)}/{action}");
        RenderLifecycle(response);
        return 0;
    }

    private async Task<int> UpdatePlanAsync(string[] args)
    {
        var options = ParseUpdateOptions(args, requirePlanDigest: false);
        using var core = await OpenCoreAsync();
        var response = await core.PostAsync<AppUpdatePlan>($"apps/{Uri.EscapeDataString(options.AppId)}/update/plan", new AppUpdatePlanRequest(
            ManifestPath: options.ManifestPath,
            SelectedRuntime: options.SelectedRuntime,
            TargetChannel: options.TargetChannel));
        RenderUpdatePlan(response);
        return 0;
    }

    private async Task<int> UpdateAsync(string[] args)
    {
        var options = ParseUpdateOptions(args, requirePlanDigest: true);
        using var core = await OpenCoreAsync();
        var response = await core.PostAsync<AppLifecycleResponse>($"apps/{Uri.EscapeDataString(options.AppId)}/update", new AppUpdateApplyRequest(
            PlanDigest: options.PlanDigest!,
            ManifestPath: options.ManifestPath,
            SelectedRuntime: options.SelectedRuntime,
            TargetChannel: options.TargetChannel));
        RenderLifecycle(response);
        return 0;
    }

    private async Task<int> SwitchRuntimePlanAsync(string[] args)
    {
        var options = ParseSwitchRuntimeOptions(args, requirePlanDigest: false);
        using var core = await OpenCoreAsync();
        var response = await core.PostAsync<AppRuntimeSwitchPlan>(
            $"apps/{Uri.EscapeDataString(options.AppId)}/switch-runtime/plan",
            new AppRuntimeSwitchPlanRequest(options.TargetRuntime));
        RenderRuntimeSwitchPlan(response);
        return 0;
    }

    private async Task<int> SwitchRuntimeAsync(string[] args)
    {
        var options = ParseSwitchRuntimeOptions(args, requirePlanDigest: true);
        using var core = await OpenCoreAsync();
        var response = await core.PostAsync<AppLifecycleResponse>(
            $"apps/{Uri.EscapeDataString(options.AppId)}/switch-runtime",
            new AppRuntimeSwitchApplyRequest(options.TargetRuntime, options.PlanDigest!));
        RenderLifecycle(response);
        return 0;
    }

    private async Task<int> RemoveAsync(string[] args)
    {
        var options = ParseRemoveOptions(args);
        using var core = await OpenCoreAsync();
        var response = await core.PostAsync<AppLifecycleResponse>($"apps/{Uri.EscapeDataString(options.AppId)}/remove", new AppRemoveRequest(
            DeleteRuntimeState: options.DeleteRuntimeState,
            DeleteData: options.DeleteData,
            DeleteBackups: options.DeleteBackups,
            DeleteSource: options.DeleteSource,
            IgnoreRuntimeErrors: options.IgnoreRuntimeErrors));
        RenderLifecycle(response);
        return 0;
    }

    private async Task<int> BackupAsync(string[] args)
    {
        if (args is ["delete", ..])
        {
            return await DeleteBackupAsync(args[1..]);
        }

        var options = ParseBackupOptions(args);
        using var core = await OpenCoreAsync();
        var response = await core.PostAsync<AppBackupResponse>($"apps/{Uri.EscapeDataString(options.AppId)}/backups", new AppManualBackupRequest(options.Reason));
        RenderBackup(response?.Backup);
        return 0;
    }

    private async Task<int> BackupsAsync(string[] args)
    {
        if (args is ["prune-plan", ..])
        {
            return await BackupCleanupPlanAsync(args[1..]);
        }

        if (args is ["prune", ..])
        {
            return await BackupCleanupAsync(args[1..]);
        }

        var appId = RequireSingleAppId(args, "apps backups");
        using var core = await OpenCoreAsync();
        var response = await core.GetAsync<AppBackupsResponse>($"apps/{Uri.EscapeDataString(appId)}/backups");
        RenderBackups(response?.Backups ?? []);
        return 0;
    }

    private async Task<int> RestoreAsync(string[] args)
    {
        var options = ParseRestoreOptions(args);
        using var core = await OpenCoreAsync();
        var response = await core.PostAsync<AppBackupResponse>(
            $"apps/{Uri.EscapeDataString(options.AppId)}/backups/{Uri.EscapeDataString(options.BackupId)}/restore",
            new AppRestoreBackupRequest(options.CreatePreRestoreBackup));
        RenderBackup(response?.Backup);
        return 0;
    }

    private async Task<int> DeleteBackupAsync(string[] args)
    {
        var options = ParseDeleteBackupOptions(args);
        using var core = await OpenCoreAsync();
        var response = await core.DeleteAsync<AppBackupDeleteResponse>(
            $"apps/{Uri.EscapeDataString(options.AppId)}/backups/{Uri.EscapeDataString(options.BackupId)}");
        context.Console.MarkupLine(response?.Deleted == true
            ? $"[green]Deleted backup:[/] {Markup.Escape(options.BackupId)}"
            : $"[yellow]Backup not found:[/] {Markup.Escape(options.BackupId)}");
        return response?.Deleted == true ? 0 : 1;
    }

    private async Task<int> BackupCleanupPlanAsync(string[] args)
    {
        var options = ParseBackupCleanupPlanOptions(args, "backups prune-plan");
        using var core = await OpenCoreAsync();
        var response = await core.GetAsync<AppBackupCleanupPlan>(
            $"apps/{Uri.EscapeDataString(options.AppId)}/backups/cleanup/plan");
        RenderBackupCleanupPlan(response, options.Format);
        return 0;
    }

    private async Task<int> BackupCleanupAsync(string[] args)
    {
        var options = ParseBackupCleanupOptions(args);
        using var core = await OpenCoreAsync();
        var response = await core.PostAsync<AppBackupCleanupApplyResponse>(
            $"apps/{Uri.EscapeDataString(options.AppId)}/backups/cleanup",
            new AppBackupCleanupApplyRequest(options.PlanDigest));
        RenderBackupCleanupResult(response, options.Format);
        return 0;
    }

    private async Task<int> LogsAsync(string[] args)
    {
        var options = ParseLogsOptions(args);
        using var core = await OpenCoreAsync();
        var response = await core.GetAsync<AppLogsResponse>($"apps/{Uri.EscapeDataString(options.AppId)}/logs?tail={options.Tail}");
        context.Console.WriteLine(response?.Text ?? "");
        return 0;
    }

    private async Task<int> HealthAsync(string[] args)
    {
        var options = ParseSourceOptions(args, "health");
        using var core = await OpenCoreAsync();
        var response = await core.GetAsync<AppRuntimeHealthResponse>($"apps/{Uri.EscapeDataString(options.AppId)}/health");
        RenderHealth(response, options.Format);
        return 0;
    }

    private async Task<int> SourceAsync(string[] args)
    {
        var options = ParseSourceOptions(args, "source");
        using var core = await OpenCoreAsync();
        var response = await core.GetAsync<AppSourceResponse>($"apps/{Uri.EscapeDataString(options.AppId)}/source");
        RenderSource(response, options.Format);
        return 0;
    }

    private async Task<int> SourceResolveAsync(string[] args)
    {
        var options = ParseSourceResolveOptions(args);
        using var core = await OpenCoreAsync();
        var response = await core.PostAsync<AppSourceResponse>(
            $"apps/{Uri.EscapeDataString(options.AppId)}/source/resolve",
            new AppSourceResolveRequest(options.Branch, options.Tag, options.Commit, options.Fetch));
        RenderSource(response, options.Format);
        return 0;
    }

    private async Task<int> SourceOverrideAsync(string[] args)
    {
        var options = ParseSourceOverrideOptions(args, context.Environment);
        using var core = await OpenCoreAsync();
        var response = await core.PostAsync<AppSourceResponse>(
            $"apps/{Uri.EscapeDataString(options.AppId)}/source/override",
            new AppSourceOverrideRequest(options.Path, options.Commit));
        RenderSource(response, options.Format);
        return 0;
    }

    private async Task<int> SourceClearOverrideAsync(string[] args)
    {
        var options = ParseSourceOptions(args, "source-clear-override");
        using var core = await OpenCoreAsync();
        var response = await core.DeleteAsync<AppSourceResponse>($"apps/{Uri.EscapeDataString(options.AppId)}/source/override");
        RenderSource(response, options.Format);
        return 0;
    }

    private async Task<int> SourceCleanupPlanAsync(string[] args)
    {
        var options = ParseSourceCleanupOptions(args, "source-cleanup-plan");
        using var core = await OpenCoreAsync();
        var response = await core.GetAsync<AppSourceCleanupPlan>("sources/cleanup/plan");
        RenderSourceCleanup(response?.Candidates ?? [], "Candidates", options.Format);
        return 0;
    }

    private async Task<int> SourceCleanupAsync(string[] args)
    {
        var options = ParseSourceCleanupOptions(args, "source-cleanup");
        using var core = await OpenCoreAsync();
        var response = await core.PostAsync<AppSourceCleanupApplyResponse>("sources/cleanup");
        RenderSourceCleanup(response?.Deleted ?? [], "Deleted", options.Format);
        return 0;
    }

    private async Task<int> IdentityAsync(string[] args)
    {
        var options = ParseIdentityOptions(args);
        using var core = await OpenCoreAsync();
        var response = await core.PostAsync<AppIdentityIssueResponse>(
            $"apps/{Uri.EscapeDataString(options.AppId)}/identity",
            new AppIdentityIssueRequest(options.User));
        if (response is null)
        {
            return 1;
        }

        RenderIdentity(response, options.Format);
        return 0;
    }

    private async Task<int> OpenAsync(string[] args)
    {
        var options = ParseOpenOptions(args);
        using var core = await OpenCoreAsync();
        var response = await core.PostAsync<AppOpenLinkResponse>(
            $"apps/{Uri.EscapeDataString(options.AppId)}/open-link",
            new AppOpenLinkRequest(options.User, options.Mode, options.RedirectUri));
        if (response is null)
        {
            return 1;
        }

        if (options.Format == "json")
        {
            context.Console.WriteLine(JsonSerializer.Serialize(response, JsonOptions));
        }
        else
        {
            context.Console.WriteLine(response.Url);
        }

        return 0;
    }

    private async Task<CoreControlClient> OpenCoreAsync()
    {
        var core = await CoreControlClient.TryCreateAsync(context);
        if (core is null)
        {
            throw new CommandUsageException(
                "Hosty Core is not running or local control discovery is unavailable. Run `hosty core start` first.",
                Usage);
        }

        return core;
    }

    private void RenderApps(IReadOnlyList<AppSummary> apps)
    {
        var table = new Table();
        table.AddColumn("App");
        table.AddColumn("Version");
        table.AddColumn("Runtime");
        table.AddColumn("Autostart");
        table.AddColumn("State");
        table.AddColumn("Status");
        foreach (var app in apps)
        {
            table.AddRow(
                Markup.Escape(app.Id),
                Markup.Escape(app.Version),
                Markup.Escape(app.SelectedRuntime ?? ""),
                app.Autostart ? "yes" : "no",
                Markup.Escape(app.RuntimeState),
                Markup.Escape(app.OperationStatus));
        }

        context.Console.Write(table);
    }

    private void RenderLifecycle(AppLifecycleResponse? response)
    {
        if (response?.App is null)
        {
            context.Console.MarkupLine($"[green]{Markup.Escape(response?.Status ?? "ok")}[/]");
            return;
        }

        context.Console.MarkupLine($"[green]{Markup.Escape(response.Status)}:[/] {Markup.Escape(response.App.Id)}");
        context.Console.MarkupLine($"[grey]Runtime:[/] {Markup.Escape(response.App.SelectedRuntime ?? "none")} / {Markup.Escape(response.App.RuntimeState)}");
        context.Console.MarkupLine($"[grey]Autostart:[/] {(response.App.Autostart ? "enabled" : "disabled")}");
        if (response.Backup is not null)
        {
            context.Console.MarkupLine($"[grey]Backup:[/] {Markup.Escape(response.Backup.BackupId)}");
        }
    }

    private void RenderUpdatePlan(AppUpdatePlan? plan)
    {
        if (plan is null)
        {
            context.Console.MarkupLine("[yellow]No update plan returned.[/]");
            return;
        }

        var table = new Table();
        table.AddColumn("Field");
        table.AddColumn("Value");
        table.AddRow("App", Markup.Escape(plan.AppId));
        table.AddRow("Version", Markup.Escape($"{plan.CurrentVersion} -> {plan.TargetVersion}"));
        table.AddRow("Runtime", Markup.Escape($"{plan.CurrentRuntime ?? "none"} -> {plan.TargetRuntime}"));
        table.AddRow("Channel", Markup.Escape(plan.TargetChannel ?? "not configured"));
        table.AddRow("Pre-update backup", plan.WillCreatePreUpdateBackup ? "yes" : "no");
        table.AddRow("Manifest digest", Markup.Escape(plan.ManifestDigest));
        table.AddRow("Plan digest", Markup.Escape(plan.PlanDigest));
        context.Console.Write(table);
    }

    private void RenderRuntimeSwitchPlan(AppRuntimeSwitchPlan? plan)
    {
        if (plan is null)
        {
            context.Console.MarkupLine("[yellow]No runtime switch plan returned.[/]");
            return;
        }

        var table = new Table();
        table.AddColumn("Field");
        table.AddColumn("Value");
        table.AddRow("App", Markup.Escape(plan.AppId));
        table.AddRow("Runtime", Markup.Escape($"{plan.CurrentRuntime ?? "none"} -> {plan.TargetRuntime}"));
        table.AddRow("Runtime type", Markup.Escape(plan.TargetRuntimeType));
        table.AddRow("Automatic backup", plan.AutomaticBackup ? "yes" : "no");
        if (plan.Changes.Count > 0)
        {
            table.AddRow("Changes", Markup.Escape(string.Join(Environment.NewLine, plan.Changes)));
        }

        table.AddRow("Plan digest", Markup.Escape(plan.PlanDigest));
        context.Console.Write(table);
    }

    private void RenderBackup(AppBackupRecord? backup)
    {
        if (backup is null)
        {
            context.Console.MarkupLine("[yellow]No app data directory exists; backup was not created or restored.[/]");
            return;
        }

        context.Console.MarkupLine($"[green]Backup:[/] {Markup.Escape(backup.BackupId)}");
        context.Console.MarkupLine($"[grey]Reason:[/] {Markup.Escape(backup.Reason)}");
        context.Console.MarkupLine($"[grey]Archive:[/] {Markup.Escape(backup.ArchivePath)}");
    }

    private void RenderBackups(IReadOnlyList<AppBackupRecord> backups)
    {
        var table = new Table();
        table.AddColumn("Backup");
        table.AddColumn("Reason");
        table.AddColumn("Created");
        table.AddColumn("Size");
        table.AddColumn("Retention");
        foreach (var backup in backups)
        {
            table.AddRow(
                Markup.Escape(backup.BackupId),
                Markup.Escape(backup.Reason),
                Markup.Escape(backup.CreatedAt.ToString("u")),
                backup.ArchiveSize.ToString(System.Globalization.CultureInfo.InvariantCulture),
                Markup.Escape(backup.Retention?.Reason ?? ""));
        }

        context.Console.Write(table);
    }

    private void RenderBackupCleanupPlan(AppBackupCleanupPlan? plan, string format)
    {
        if (format == "json")
        {
            context.Console.WriteLine(JsonSerializer.Serialize(plan, JsonOptions));
            return;
        }

        if (format != "table")
        {
            throw new CommandUsageException("apps backups prune-plan --format must be table or json.", Usage);
        }

        if (plan is null)
        {
            context.Console.MarkupLine("[yellow]No backup cleanup plan returned.[/]");
            return;
        }

        context.Console.MarkupLine($"[grey]Plan digest:[/] {Markup.Escape(plan.PlanDigest)}");
        RenderBackupCleanupCandidates(plan.Candidates, "Candidates");
    }

    private void RenderBackupCleanupResult(AppBackupCleanupApplyResponse? response, string format)
    {
        if (format == "json")
        {
            context.Console.WriteLine(JsonSerializer.Serialize(response, JsonOptions));
            return;
        }

        if (format != "table")
        {
            throw new CommandUsageException("apps backups prune --format must be table or json.", Usage);
        }

        if (response is null)
        {
            context.Console.MarkupLine("[yellow]No backup cleanup response returned.[/]");
            return;
        }

        context.Console.MarkupLine($"[green]Deleted:[/] {response.Deleted.Count}");
        RenderBackupCleanupCandidates(response.Deleted, "Deleted");
        if (response.Skipped.Count > 0)
        {
            context.Console.MarkupLine($"[yellow]Skipped:[/] {response.Skipped.Count}");
            RenderBackupCleanupCandidates(response.Skipped, "Skipped");
        }
    }

    private void RenderBackupCleanupCandidates(IReadOnlyList<AppBackupCleanupCandidate> candidates, string title)
    {
        var table = new Table();
        table.AddColumn(title);
        table.AddColumn("Reason");
        table.AddColumn("Cleanup");
        table.AddColumn("Path");
        foreach (var candidate in candidates)
        {
            table.AddRow(
                Markup.Escape(candidate.BackupId),
                Markup.Escape(candidate.Reason),
                Markup.Escape(candidate.CleanupReason),
                Markup.Escape(candidate.ArchivePath ?? candidate.MetadataPath ?? ""));
        }

        context.Console.Write(table);
    }

    private void RenderSource(AppSourceResponse? response, string format)
    {
        if (format == "json")
        {
            context.Console.WriteLine(JsonSerializer.Serialize(response ?? new AppSourceResponse("", null), JsonOptions));
            return;
        }

        if (format != "table")
        {
            throw new CommandUsageException("apps source --format must be table or json.", Usage);
        }

        if (response?.Source is null)
        {
            context.Console.MarkupLine($"[yellow]No source state for {Markup.Escape(response?.AppId ?? "app")}.[/]");
            return;
        }

        var source = response.Source;
        var table = new Table();
        table.AddColumn("Field");
        table.AddColumn("Value");
        table.AddRow("App", Markup.Escape(response.AppId));
        table.AddRow("Type", Markup.Escape(source.Type ?? ""));
        table.AddRow("Repository", Markup.Escape(source.Repository ?? ""));
        table.AddRow("Resolved ref", Markup.Escape(source.ResolvedRef ?? ""));
        table.AddRow("Commit", Markup.Escape(source.Commit ?? ""));
        table.AddRow("Managed checkout", Markup.Escape(source.ManagedCheckoutPath ?? ""));
        table.AddRow("Local override", Markup.Escape(source.LocalOverridePath ?? ""));
        table.AddRow("Updated", Markup.Escape(source.UpdatedAt?.ToString("u") ?? ""));
        context.Console.Write(table);
    }

    private void RenderHealth(AppRuntimeHealthResponse? response, string format)
    {
        if (format == "json")
        {
            context.Console.WriteLine(JsonSerializer.Serialize(response ?? new AppRuntimeHealthResponse("", "", "", "unknown", []), JsonOptions));
            return;
        }

        if (format != "table")
        {
            throw new CommandUsageException("apps health --format must be table or json.", Usage);
        }

        if (response is null)
        {
            context.Console.MarkupLine("[yellow]No runtime health returned.[/]");
            return;
        }

        context.Console.MarkupLine($"[green]{Markup.Escape(response.Status)}:[/] {Markup.Escape(response.AppId)}");
        context.Console.MarkupLine($"[grey]Runtime:[/] {Markup.Escape(response.Runtime)} / {Markup.Escape(response.RuntimeType)}");
        var table = new Table();
        table.AddColumn("Service");
        table.AddColumn("Status");
        table.AddColumn("PID");
        table.AddColumn("Exit");
        table.AddColumn("Log");
        table.AddColumn("Working directory");
        foreach (var service in response.Services)
        {
            table.AddRow(
                Markup.Escape(service.Service),
                Markup.Escape(service.Status),
                Markup.Escape(service.ProcessId?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? ""),
                Markup.Escape(service.ExitCode?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? ""),
                Markup.Escape(service.LogPath ?? ""),
                Markup.Escape(service.WorkingDirectory ?? ""));
        }

        context.Console.Write(table);
    }

    private void RenderSourceCleanup(IReadOnlyList<AppSourceCleanupCandidate> candidates, string title, string format)
    {
        if (format == "json")
        {
            context.Console.WriteLine(JsonSerializer.Serialize(new AppSourceCleanupOutput(candidates), JsonOptions));
            return;
        }

        if (format != "table")
        {
            throw new CommandUsageException("apps source cleanup --format must be table or json.", Usage);
        }

        var table = new Table();
        table.AddColumn(title);
        table.AddColumn("Path");
        table.AddColumn("Reason");
        foreach (var candidate in candidates)
        {
            table.AddRow(
                Markup.Escape(candidate.AppId),
                Markup.Escape(candidate.Path),
                Markup.Escape(candidate.Reason));
        }

        context.Console.Write(table);
    }

    private void RenderIdentity(AppIdentityIssueResponse response, string format)
    {
        switch (format)
        {
            case "token":
                context.Console.WriteLine(response.Token.AccessToken);
                break;
            case "header":
                context.Console.WriteLine($"Authorization: {response.Token.TokenType} {response.Token.AccessToken}");
                break;
            case "env":
                context.Console.WriteLine($"HOSTY_APP_ID={response.AppId}");
                context.Console.WriteLine($"HOSTY_USER_ID={response.UserId}");
                context.Console.WriteLine($"HOSTY_APP_IDENTITY_TOKEN={response.Token.AccessToken}");
                break;
            case "json":
                context.Console.WriteLine(JsonSerializer.Serialize(response, JsonOptions));
                break;
            default:
                throw new CommandUsageException("--format must be token, header, env, or json.", Usage);
        }
    }

    private static InstallOptions ParseInstallOptions(string[] args)
    {
        string? manifestPath = null;
        string? selectedRuntime = null;
        string? selectedChannel = null;
        var system = false;
        bool? autostart = null;

        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--manifest":
                    manifestPath = RequireOptionValue(args, ref index, "--manifest");
                    break;
                case "--runtime":
                    selectedRuntime = RequireOptionValue(args, ref index, "--runtime");
                    break;
                case "--channel":
                    selectedChannel = RequireOptionValue(args, ref index, "--channel");
                    break;
                case "--system":
                    system = true;
                    break;
                case "--autostart":
                    autostart = true;
                    break;
                case "--no-autostart":
                    autostart = false;
                    break;
                default:
                    if (manifestPath is null)
                    {
                        manifestPath = args[index];
                    }
                    else
                    {
                        throw new CommandUsageException($"Unknown apps install argument '{args[index]}'.", Usage);
                    }

                    break;
            }
        }

        if (string.IsNullOrWhiteSpace(manifestPath))
        {
            throw new CommandUsageException("apps install requires a manifest path.", Usage);
        }

        return new InstallOptions(NormalizeManifestReference(manifestPath), selectedRuntime, selectedChannel, system, autostart);
    }

    private static AutostartOptions ParseAutostartOptions(string[] args)
    {
        if (args.Length == 0)
        {
            throw new CommandUsageException("apps autostart requires an app id.", Usage);
        }

        var appId = args[0];
        bool? autostart = null;
        for (var index = 1; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--enabled":
                case "--on":
                case "--autostart":
                    autostart = true;
                    break;
                case "--disabled":
                case "--off":
                case "--no-autostart":
                    autostart = false;
                    break;
                default:
                    throw new CommandUsageException($"Unknown apps autostart argument '{args[index]}'.", Usage);
            }
        }

        if (autostart is null)
        {
            throw new CommandUsageException("apps autostart requires --enabled or --disabled.", Usage);
        }

        return new AutostartOptions(appId, autostart.Value);
    }

    private static UpdateOptions ParseUpdateOptions(string[] args, bool requirePlanDigest)
    {
        if (args.Length == 0)
        {
            throw new CommandUsageException("apps update requires an app id.", Usage);
        }

        var appId = args[0];
        string? manifestPath = null;
        string? selectedRuntime = null;
        string? targetChannel = null;
        string? planDigest = null;

        for (var index = 1; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--manifest":
                    manifestPath = NormalizeManifestReference(RequireOptionValue(args, ref index, "--manifest"));
                    break;
                case "--runtime":
                    selectedRuntime = RequireOptionValue(args, ref index, "--runtime");
                    break;
                case "--channel":
                    targetChannel = RequireOptionValue(args, ref index, "--channel");
                    break;
                case "--plan-digest":
                    planDigest = RequireOptionValue(args, ref index, "--plan-digest");
                    break;
                default:
                    throw new CommandUsageException($"Unknown apps update argument '{args[index]}'.", Usage);
            }
        }

        if (requirePlanDigest && string.IsNullOrWhiteSpace(planDigest))
        {
            throw new CommandUsageException("apps update requires --plan-digest. Run `hosty apps update-plan <app-id>` first.", Usage);
        }

        return new UpdateOptions(appId, manifestPath, selectedRuntime, targetChannel, planDigest);
    }

    private static RemoveOptions ParseRemoveOptions(string[] args)
    {
        if (args.Length == 0)
        {
            throw new CommandUsageException("apps remove requires an app id.", Usage);
        }

        var appId = args[0];
        var deleteRuntimeState = true;
        var deleteData = false;
        var deleteBackups = false;
        var deleteSource = false;
        var ignoreRuntimeErrors = false;
        for (var index = 1; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--keep-state":
                    deleteRuntimeState = false;
                    break;
                case "--delete-data":
                    deleteData = true;
                    break;
                case "--delete-backups":
                    deleteBackups = true;
                    break;
                case "--delete-source":
                    deleteSource = true;
                    break;
                case "--ignore-runtime-errors":
                    ignoreRuntimeErrors = true;
                    break;
                default:
                    throw new CommandUsageException($"Unknown apps remove argument '{args[index]}'.", Usage);
            }
        }

        return new RemoveOptions(appId, deleteRuntimeState, deleteData, deleteBackups, deleteSource, ignoreRuntimeErrors);
    }

    private static SwitchRuntimeOptions ParseSwitchRuntimeOptions(string[] args, bool requirePlanDigest)
    {
        if (args.Length == 0)
        {
            throw new CommandUsageException("apps switch-runtime requires an app id.", Usage);
        }

        var appId = args[0];
        string? targetRuntime = null;
        string? planDigest = null;
        for (var index = 1; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--runtime":
                    targetRuntime = RequireOptionValue(args, ref index, "--runtime");
                    break;
                case "--plan-digest":
                    planDigest = RequireOptionValue(args, ref index, "--plan-digest");
                    break;
                default:
                    throw new CommandUsageException($"Unknown apps switch-runtime argument '{args[index]}'.", Usage);
            }
        }

        if (string.IsNullOrWhiteSpace(targetRuntime))
        {
            throw new CommandUsageException("apps switch-runtime requires --runtime <key>.", Usage);
        }

        if (requirePlanDigest && string.IsNullOrWhiteSpace(planDigest))
        {
            throw new CommandUsageException("apps switch-runtime requires --plan-digest. Run switch-runtime-plan first.", Usage);
        }

        return new SwitchRuntimeOptions(appId, targetRuntime, planDigest);
    }

    private static BackupOptions ParseBackupOptions(string[] args)
    {
        if (args.Length == 0)
        {
            throw new CommandUsageException("apps backup requires an app id.", Usage);
        }

        var appId = args[0];
        string? reason = null;
        for (var index = 1; index < args.Length; index++)
        {
            if (args[index] == "--reason")
            {
                reason = RequireOptionValue(args, ref index, "--reason");
            }
            else
            {
                throw new CommandUsageException($"Unknown apps backup argument '{args[index]}'.", Usage);
            }
        }

        return new BackupOptions(appId, reason);
    }

    private static RestoreOptions ParseRestoreOptions(string[] args)
    {
        if (args.Length < 2)
        {
            throw new CommandUsageException("apps restore requires an app id and backup id.", Usage);
        }

        var createPreRestoreBackup = false;
        for (var index = 2; index < args.Length; index++)
        {
            if (args[index] == "--pre-restore-backup")
            {
                createPreRestoreBackup = true;
            }
            else
            {
                throw new CommandUsageException($"Unknown apps restore argument '{args[index]}'.", Usage);
            }
        }

        return new RestoreOptions(args[0], args[1], createPreRestoreBackup);
    }

    private static DeleteBackupOptions ParseDeleteBackupOptions(string[] args)
    {
        if (args.Length < 2)
        {
            throw new CommandUsageException("apps backup delete requires an app id and backup id.", Usage);
        }

        var confirmed = false;
        for (var index = 2; index < args.Length; index++)
        {
            if (args[index] == "--yes")
            {
                confirmed = true;
            }
            else
            {
                throw new CommandUsageException($"Unknown apps backup delete argument '{args[index]}'.", Usage);
            }
        }

        if (!confirmed)
        {
            throw new CommandUsageException("apps backup delete requires --yes to confirm deletion.", Usage);
        }

        return new DeleteBackupOptions(args[0], args[1]);
    }

    private static BackupCleanupPlanOptions ParseBackupCleanupPlanOptions(string[] args, string commandName)
    {
        if (args.Length == 0)
        {
            throw new CommandUsageException($"apps {commandName} requires an app id.", Usage);
        }

        var appId = args[0];
        var format = "table";
        for (var index = 1; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--format":
                    format = RequireOptionValue(args, ref index, "--format");
                    break;
                default:
                    throw new CommandUsageException($"Unknown apps {commandName} argument '{args[index]}'.", Usage);
            }
        }

        ValidateBackupFormat(format, commandName);
        return new BackupCleanupPlanOptions(appId, format);
    }

    private static BackupCleanupOptions ParseBackupCleanupOptions(string[] args)
    {
        if (args.Length == 0)
        {
            throw new CommandUsageException("apps backups prune requires an app id.", Usage);
        }

        var appId = args[0];
        string? planDigest = null;
        var confirmed = false;
        var format = "table";
        for (var index = 1; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--plan-digest":
                    planDigest = RequireOptionValue(args, ref index, "--plan-digest");
                    break;
                case "--yes":
                    confirmed = true;
                    break;
                case "--format":
                    format = RequireOptionValue(args, ref index, "--format");
                    break;
                default:
                    throw new CommandUsageException($"Unknown apps backups prune argument '{args[index]}'.", Usage);
            }
        }

        if (string.IsNullOrWhiteSpace(planDigest))
        {
            throw new CommandUsageException("apps backups prune requires --plan-digest. Run `hosty apps backups prune-plan <app-id>` first.", Usage);
        }

        if (!confirmed)
        {
            throw new CommandUsageException("apps backups prune requires --yes to confirm deletion.", Usage);
        }

        ValidateBackupFormat(format, "backups prune");
        return new BackupCleanupOptions(appId, planDigest, format);
    }

    private static LogsOptions ParseLogsOptions(string[] args)
    {
        if (args.Length == 0)
        {
            throw new CommandUsageException("apps logs requires an app id.", Usage);
        }

        var tail = 200;
        for (var index = 1; index < args.Length; index++)
        {
            if (args[index] == "--tail")
            {
                if (!int.TryParse(RequireOptionValue(args, ref index, "--tail"), out tail) || tail < 1)
                {
                    throw new CommandUsageException("--tail must be a positive integer.", Usage);
                }
            }
            else
            {
                throw new CommandUsageException($"Unknown apps logs argument '{args[index]}'.", Usage);
            }
        }

        return new LogsOptions(args[0], tail);
    }

    private static SourceOptions ParseSourceOptions(string[] args, string commandName)
    {
        if (args.Length == 0)
        {
            throw new CommandUsageException($"apps {commandName} requires an app id.", Usage);
        }

        var appId = args[0];
        var format = "table";
        for (var index = 1; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--format":
                    format = RequireOptionValue(args, ref index, "--format");
                    break;
                default:
                    throw new CommandUsageException($"Unknown apps {commandName} argument '{args[index]}'.", Usage);
            }
        }

        ValidateSourceFormat(format);
        return new SourceOptions(appId, format);
    }

    private static SourceResolveOptions ParseSourceResolveOptions(string[] args)
    {
        if (args.Length == 0)
        {
            throw new CommandUsageException("apps source-resolve requires an app id.", Usage);
        }

        var appId = args[0];
        string? branch = null;
        string? tag = null;
        string? commit = null;
        var fetch = false;
        var format = "table";
        for (var index = 1; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--branch":
                    branch = RequireOptionValue(args, ref index, "--branch");
                    break;
                case "--tag":
                    tag = RequireOptionValue(args, ref index, "--tag");
                    break;
                case "--commit":
                    commit = RequireOptionValue(args, ref index, "--commit");
                    break;
                case "--fetch":
                    fetch = true;
                    break;
                case "--format":
                    format = RequireOptionValue(args, ref index, "--format");
                    break;
                default:
                    throw new CommandUsageException($"Unknown apps source-resolve argument '{args[index]}'.", Usage);
            }
        }

        var refCount = new[] { branch, tag, commit }.Count(value => !string.IsNullOrWhiteSpace(value));
        if (refCount > 1)
        {
            throw new CommandUsageException("apps source-resolve accepts only one of --branch, --tag, or --commit.", Usage);
        }

        ValidateSourceFormat(format);
        return new SourceResolveOptions(appId, branch, tag, commit, fetch, format);
    }

    private static SourceOverrideOptions ParseSourceOverrideOptions(string[] args, DockerHostEnvironment environment)
    {
        if (args.Length == 0)
        {
            throw new CommandUsageException("apps source-override requires an app id.", Usage);
        }

        var appId = args[0];
        string? overridePath = null;
        string? commit = null;
        var format = "table";
        for (var index = 1; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--path":
                    overridePath = RequireOptionValue(args, ref index, "--path");
                    break;
                case "--commit":
                    commit = RequireOptionValue(args, ref index, "--commit");
                    break;
                case "--format":
                    format = RequireOptionValue(args, ref index, "--format");
                    break;
                default:
                    throw new CommandUsageException($"Unknown apps source-override argument '{args[index]}'.", Usage);
            }
        }

        if (string.IsNullOrWhiteSpace(overridePath))
        {
            throw new CommandUsageException("apps source-override requires --path <worktree>.", Usage);
        }

        ValidateSourceFormat(format);
        return new SourceOverrideOptions(appId, environment.ResolvePath(overridePath), commit, format);
    }

    private static SourceCleanupOptions ParseSourceCleanupOptions(string[] args, string commandName)
    {
        var format = "table";
        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--format":
                    format = RequireOptionValue(args, ref index, "--format");
                    break;
                default:
                    throw new CommandUsageException($"Unknown apps {commandName} argument '{args[index]}'.", Usage);
            }
        }

        ValidateSourceFormat(format);
        return new SourceCleanupOptions(format);
    }

    private static void ValidateSourceFormat(string format)
    {
        if (format is not "table" and not "json")
        {
            throw new CommandUsageException("apps source --format must be table or json.", Usage);
        }
    }

    private static void ValidateBackupFormat(string format, string commandName)
    {
        if (format is not "table" and not "json")
        {
            throw new CommandUsageException($"apps {commandName} --format must be table or json.", Usage);
        }
    }

    private static IdentityOptions ParseIdentityOptions(string[] args)
    {
        if (args.Length == 0)
        {
            throw new CommandUsageException("apps identity requires an app id.", Usage);
        }

        var appId = args[0];
        string? user = null;
        var format = "token";
        for (var index = 1; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--user":
                    user = RequireOptionValue(args, ref index, "--user");
                    break;
                case "--format":
                    format = RequireOptionValue(args, ref index, "--format");
                    break;
                default:
                    throw new CommandUsageException($"Unknown apps identity argument '{args[index]}'.", Usage);
            }
        }

        if (string.IsNullOrWhiteSpace(user))
        {
            throw new CommandUsageException("apps identity requires --user <email-or-id>.", Usage);
        }

        return new IdentityOptions(appId, user, format);
    }

    private static OpenOptions ParseOpenOptions(string[] args)
    {
        if (args.Length == 0)
        {
            throw new CommandUsageException("apps open requires an app id.", Usage);
        }

        var appId = args[0];
        string? user = null;
        var mode = "standalone";
        string? redirectUri = null;
        var format = "url";
        for (var index = 1; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--user":
                    user = RequireOptionValue(args, ref index, "--user");
                    break;
                case "--mode":
                    mode = RequireOptionValue(args, ref index, "--mode");
                    break;
                case "--redirect-uri":
                    redirectUri = RequireOptionValue(args, ref index, "--redirect-uri");
                    break;
                case "--format":
                    format = RequireOptionValue(args, ref index, "--format");
                    break;
                default:
                    throw new CommandUsageException($"Unknown apps open argument '{args[index]}'.", Usage);
            }
        }

        if (string.IsNullOrWhiteSpace(user))
        {
            throw new CommandUsageException("apps open requires --user <email-or-id>.", Usage);
        }

        if (format is not "url" and not "json")
        {
            throw new CommandUsageException("apps open --format must be url or json.", Usage);
        }

        return new OpenOptions(appId, user, mode, redirectUri, format);
    }

    private static string RequireSingleAppId(string[] args, string command)
    {
        if (args.Length != 1)
        {
            throw new CommandUsageException($"{command} requires exactly one app id.", Usage);
        }

        return args[0];
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

    private static string NormalizeManifestReference(string value)
    {
        var manifestReference = value.Trim();
        if (Uri.TryCreate(manifestReference, UriKind.Absolute, out var uri) &&
            (string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)))
        {
            return uri.AbsoluteUri;
        }

        return Path.GetFullPath(manifestReference);
    }

    private sealed record InstallOptions(string ManifestPath, string? SelectedRuntime, string? SelectedChannel, bool System, bool? Autostart);

    private sealed record AutostartOptions(string AppId, bool Autostart);

    private sealed record UpdateOptions(string AppId, string? ManifestPath, string? SelectedRuntime, string? TargetChannel, string? PlanDigest);

    private sealed record RemoveOptions(string AppId, bool DeleteRuntimeState, bool DeleteData, bool DeleteBackups, bool DeleteSource, bool IgnoreRuntimeErrors);

    private sealed record SwitchRuntimeOptions(string AppId, string TargetRuntime, string? PlanDigest);

    private sealed record BackupOptions(string AppId, string? Reason);

    private sealed record RestoreOptions(string AppId, string BackupId, bool CreatePreRestoreBackup);

    private sealed record DeleteBackupOptions(string AppId, string BackupId);

    private sealed record BackupCleanupPlanOptions(string AppId, string Format);

    private sealed record BackupCleanupOptions(string AppId, string PlanDigest, string Format);

    private sealed record LogsOptions(string AppId, int Tail);

    private sealed record SourceOptions(string AppId, string Format);

    private sealed record SourceResolveOptions(string AppId, string? Branch, string? Tag, string? Commit, bool Fetch, string Format);

    private sealed record SourceOverrideOptions(string AppId, string Path, string? Commit, string Format);

    private sealed record SourceCleanupOptions(string Format);

    private sealed record IdentityOptions(string AppId, string User, string Format);

    private sealed record OpenOptions(string AppId, string User, string Mode, string? RedirectUri, string Format);

    private sealed record AppsResponse(IReadOnlyList<AppSummary> Apps);

    private sealed record AppSummary(
        string Id,
        string DisplayName,
        string? Description,
        string Version,
        string Kind,
        bool System,
        string Source,
        string? SelectedChannel,
        string? SelectedRuntime,
        bool Autostart,
        string OperationStatus,
        string RuntimeState,
        string? LastOperation,
        string? LastError,
        IReadOnlyList<string> Capabilities);

    private sealed record AppInstallRequest(string ManifestPath, string? SelectedRuntime, string? SelectedChannel, bool System, bool? Autostart);

    private sealed record AppAutostartRequest(bool Autostart);

    private sealed record AppUpdatePlanRequest(string? ManifestPath, string? SelectedRuntime, string? TargetChannel);

    private sealed record AppUpdateApplyRequest(string PlanDigest, string? ManifestPath, string? SelectedRuntime, string? TargetChannel);

    private sealed record AppRemoveRequest(bool DeleteRuntimeState, bool DeleteData, bool DeleteBackups, bool DeleteSource, bool IgnoreRuntimeErrors);

    private sealed record AppRuntimeSwitchPlanRequest(string TargetRuntime);

    private sealed record AppRuntimeSwitchApplyRequest(string TargetRuntime, string PlanDigest);

    private sealed record AppManualBackupRequest(string? Reason);

    private sealed record AppRestoreBackupRequest(bool CreatePreRestoreBackup);

    private sealed record AppLifecycleResponse(AppSummary? App, AppBackupRecord? Backup, string Status);

    private sealed record AppUpdatePlan(
        string AppId,
        string CurrentVersion,
        string TargetVersion,
        string? CurrentRuntime,
        string TargetRuntime,
        string? TargetChannel,
        string ManifestPath,
        string ManifestDigest,
        string PlanDigest,
        bool WillCreatePreUpdateBackup,
        IReadOnlyList<string> Changes);

    private sealed record AppRuntimeSwitchPlan(
        string AppId,
        string? CurrentRuntime,
        string TargetRuntime,
        string TargetRuntimeType,
        string PlanDigest,
        bool AutomaticBackup,
        IReadOnlyList<string> Changes);

    private sealed record AppBackupsResponse(IReadOnlyList<AppBackupRecord> Backups);

    private sealed record AppBackupResponse(AppBackupRecord? Backup);

    private sealed record AppBackupDeleteResponse(bool Deleted);

    private sealed record AppBackupRecord(
        string AppId,
        string BackupId,
        string Reason,
        DateTimeOffset CreatedAt,
        string DataPath,
        string ArchivePath,
        string ArchiveSha256,
        long ArchiveSize,
        int FileCount,
        AppBackupRetentionStatus? Retention = null);

    private sealed record AppBackupRetentionStatus(
        bool Eligible,
        string Reason,
        bool WouldDeleteInCurrentPlan);

    private sealed record AppBackupCleanupPlan(
        string? AppId,
        string PlanDigest,
        DateTimeOffset CreatedAt,
        AppBackupRetentionPolicy Policy,
        IReadOnlyList<AppBackupCleanupCandidate> Candidates);

    private sealed record AppBackupRetentionPolicy(
        IReadOnlyDictionary<string, AppBackupRetentionRule> Rules,
        bool DeleteOnlyKnownBackup);

    private sealed record AppBackupRetentionRule(
        int? KeepLast,
        int? MaxAgeDays);

    private sealed record AppBackupCleanupCandidate(
        string AppId,
        string BackupId,
        string Reason,
        string CleanupReason,
        DateTimeOffset CreatedAt,
        string? ArchivePath,
        string? MetadataPath,
        string? ArchiveSha256,
        long? ArchiveSize,
        bool Automatic);

    private sealed record AppBackupCleanupApplyRequest(string PlanDigest);

    private sealed record AppBackupCleanupApplyResponse(
        string PlanDigest,
        IReadOnlyList<AppBackupCleanupCandidate> Deleted,
        IReadOnlyList<AppBackupCleanupCandidate> Skipped);

    private sealed record AppLogsResponse(string AppId, string Text);

    private sealed record AppRuntimeHealthResponse(
        string AppId,
        string Runtime,
        string RuntimeType,
        string Status,
        IReadOnlyList<AppRuntimeServiceHealth> Services);

    private sealed record AppRuntimeServiceHealth(
        string Service,
        string Status,
        int? ProcessId,
        int? ExitCode,
        string? LogPath,
        string? WorkingDirectory,
        string? Message);

    private sealed record AppSourceResolveRequest(string? Branch, string? Tag, string? Commit, bool Fetch);

    private sealed record AppSourceOverrideRequest(string Path, string? Commit);

    private sealed record AppSourceResponse(string AppId, AppSourceState? Source);

    private sealed record AppSourceState(
        string? Type,
        string? Repository,
        string? ResolvedRef,
        string? Commit,
        string? ManagedCheckoutPath,
        string? LocalOverridePath,
        DateTimeOffset? UpdatedAt);

    private sealed record AppSourceCleanupPlan(IReadOnlyList<AppSourceCleanupCandidate> Candidates);

    private sealed record AppSourceCleanupApplyResponse(IReadOnlyList<AppSourceCleanupCandidate> Deleted);

    private sealed record AppSourceCleanupCandidate(string AppId, string Path, string Reason);

    private sealed record AppSourceCleanupOutput(IReadOnlyList<AppSourceCleanupCandidate> Items);

    private sealed record AppIdentityIssueRequest(string User);

    private sealed record AppIdentityIssueResponse(string AppId, string UserId, AppIdentityTokenResult Token);

    private sealed record AppIdentityTokenResult(string AccessToken, string TokenType, DateTimeOffset ExpiresAt, int ExpiresInSeconds);

    private sealed record AppOpenLinkRequest(string User, string? Mode, string? RedirectUri);

    private sealed record AppOpenLinkResponse(string AppId, string UserId, string Mode, string Url, DateTimeOffset? ExpiresAt);

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private const string Usage = """
        hosty apps

        Usage:
          hosty apps <command> [options]

        Commands:
          list
          install <manifest-path> [--runtime <key>] [--channel <channel>] [--system] [--autostart|--no-autostart]
          autostart <app-id> --enabled|--disabled
          start <app-id>
          stop <app-id>
          restart <app-id>
          update-plan <app-id> [--manifest <path>] [--runtime <key>] [--channel <channel>]
          update <app-id> --plan-digest <digest> [--manifest <path>] [--runtime <key>] [--channel <channel>]
          switch-runtime-plan <app-id> --runtime <key>
          switch-runtime <app-id> --runtime <key> --plan-digest <digest>
          remove <app-id> [--delete-data] [--delete-backups] [--delete-source] [--keep-state] [--ignore-runtime-errors]
          backup <app-id> [--reason <reason>]
          backup delete <app-id> <backup-id> --yes
          backups <app-id>
          backups prune-plan <app-id> [--format table|json]
          backups prune <app-id> --plan-digest <digest> --yes [--format table|json]
          restore <app-id> <backup-id> [--pre-restore-backup]
          logs <app-id> [--tail <count>]
          health <app-id> [--format table|json]
          source <app-id> [--format table|json]
          source-resolve <app-id> [--branch <name>|--tag <tag>|--commit <sha>] [--fetch] [--format table|json]
          source-override <app-id> --path <worktree> [--commit <sha>] [--format table|json]
          source-clear-override <app-id> [--format table|json]
          source-cleanup-plan [--format table|json]
          source-cleanup [--format table|json]
          identity <app-id> --user <email-or-id> [--format token|header|env|json]
          open <app-id> --user <email-or-id> [--mode shell|standalone] [--redirect-uri <uri>] [--format url|json]

        Description:
          Calls Hosty Core lifecycle APIs for runtime app management.
        """;
}
