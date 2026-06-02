namespace Haas.DockerHost.Cli.Commands;

using System.Globalization;
using System.Net;
using System.Text.Json;
using Haas.DockerHost.Cli.Configuration;
using Haas.DockerHost.Cli.HostApi;
using Spectre.Console;

internal sealed class ModulesCommand(CommandContext context, string commandName = "modules")
{
    private string Usage => $"""
        Usage:
          hosty {commandName} list
          hosty {commandName} install <manifest-url>
          hosty {commandName} add <manifest-url>
          hosty {commandName} start <app-id>
          hosty {commandName} stop <app-id>
          hosty {commandName} restart <app-id>
          hosty {commandName} update <app-id>
          hosty {commandName} backup <app-id>
          hosty {commandName} backups <app-id>
          hosty {commandName} restore <app-id> <backup-id>
          hosty {commandName} remove <app-id> [--delete-data]
        """;

    private static readonly JsonSerializerOptions PreviewJsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
    };

    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length == 0 || args is ["--help"] or ["-h"] or ["help"])
        {
            context.Console.WriteLine(Usage);
            return 0;
        }

        return args[0] switch
        {
            "list" => await ListAsync(args[1..]),
            "install" => await InstallAsync(args[1..]),
            "add" => await InstallAsync(args[1..]),
            "start" => await RunLifecycleActionAsync("start", args[1..]),
            "stop" => await RunLifecycleActionAsync("stop", args[1..]),
            "restart" => await RunLifecycleActionAsync("restart", args[1..]),
            "update" => await UpdateAsync(args[1..]),
            "backup" => await CreateBackupAsync(args[1..]),
            "backups" => await ListBackupsAsync(args[1..]),
            "restore" => await RestoreBackupAsync(args[1..]),
            "remove" => await RemoveAsync(args[1..]),
            _ => throw new CommandUsageException($"Unknown modules command '{args[0]}'.", Usage),
        };
    }

    private async Task<int> ListAsync(string[] args)
    {
        if (args.Length != 0)
        {
            throw new CommandUsageException($"{commandName} list does not accept arguments.", $"Usage: hosty {commandName} list");
        }

        if (string.Equals(commandName, "apps", StringComparison.Ordinal))
        {
            return await ListAppsAsync();
        }

        using var hostApi = await CreateHostControlClientAsync();
        if (hostApi is null)
        {
            return 1;
        }

        var response = await hostApi.ListModulesAsync();
        if (!response.IsSuccess || response.Body is null)
        {
            return RenderApiFailure("Failed to list modules.", response.StatusCode, response.RawBody);
        }

        var modules = response.Body.Modules;
        if (modules.Count == 0)
        {
            context.Console.MarkupLine("[yellow]No installed modules.[/]");
            context.Console.WriteLine($"Install one with hosty {commandName} install <manifest-url>.");
            return 0;
        }

        var table = new Table()
            .RoundedBorder()
            .AddColumn("Module")
            .AddColumn("Version")
            .AddColumn("Operation")
            .AddColumn("Runtime")
            .AddColumn("Image tag")
            .AddColumn("Updated")
            .AddColumn("Error");

        foreach (var module in modules)
        {
            table.AddRow(
                Markup.Escape(FormatModuleLabel(module)),
                Markup.Escape(module.Version),
                Markup.Escape(module.OperationStatus),
                Markup.Escape(module.RuntimeStatus?.State ?? "unknown"),
                Markup.Escape(FormatModuleImageTags(module)),
                Markup.Escape(module.UpdatedAt ?? module.InstalledAt ?? ""),
                Markup.Escape(module.LastError?.Message ?? ""));
        }

        context.Console.Write(table);
        return 0;
    }

    private async Task<int> ListAppsAsync()
    {
        using var hostApi = await CreateHostControlClientAsync();
        if (hostApi is null)
        {
            return 1;
        }

        var response = await hostApi.ListAppsAsync();
        if (!response.IsSuccess || response.Body is null)
        {
            return RenderApiFailure("Failed to list apps.", response.StatusCode, response.RawBody);
        }

        var apps = response.Body.Apps;
        if (apps.Count == 0)
        {
            context.Console.MarkupLine("[yellow]No apps.[/]");
            context.Console.WriteLine("Install one with hosty apps install <manifest-url>.");
            return 0;
        }

        var table = new Table()
            .RoundedBorder()
            .AddColumn("App")
            .AddColumn("Kind")
            .AddColumn("Source")
            .AddColumn("Status")
            .AddColumn("Runtime")
            .AddColumn("Channel")
            .AddColumn("Capabilities");

        foreach (var app in apps)
        {
            table.AddRow(
                Markup.Escape($"{app.DisplayName} ({app.Id})"),
                Markup.Escape(app.Kind),
                Markup.Escape(app.Source),
                Markup.Escape(app.Status),
                Markup.Escape(app.SelectedRuntime ?? ""),
                Markup.Escape(app.SelectedChannel ?? ""),
                Markup.Escape(string.Join(", ", app.Capabilities)));
        }

        context.Console.Write(table);
        return 0;
    }

    private async Task<int> InstallAsync(string[] args)
    {
        if (args.Length != 1)
        {
            throw new CommandUsageException(
                $"{commandName} install requires exactly one manifest URL.",
                $"Usage: hosty {commandName} install <manifest-url>");
        }

        using var hostApi = await CreateHostControlClientAsync();
        if (hostApi is null)
        {
            return 1;
        }

        if (!await EnsureHostReadyAsync(hostApi))
        {
            return 1;
        }

        var planResponse = await hostApi.CreateInstallPlanAsync(args[0]);
        var planBody = planResponse.Body;
        if (planBody?.Mode == "update" || planBody?.UpdatePlan is not null)
        {
            context.Console.MarkupLine("[yellow]App is already installed from this manifest URL. Switching to update review.[/]");
            if (planBody?.UpdatePlan is not null)
            {
                RenderUpdatePlan(planBody.UpdatePlan);
            }

            if (!planResponse.IsSuccess || planBody?.Error is not null)
            {
                return RenderPlanFailure(
                    planBody?.Error,
                    "Failed to create app update plan.",
                    planResponse.StatusCode,
                    planResponse.RawBody);
            }

            if (planBody?.UpdatePlan is null)
            {
                return RenderApiFailure("Install plan response did not include an update plan.", planResponse.StatusCode, planResponse.RawBody);
            }

            return await ApplyReviewedUpdatePlanAsync(hostApi, planBody.UpdatePlan);
        }

        if (planBody?.Plan is not null)
        {
            RenderInstallPlan(planBody.Plan);
        }

        if (!planResponse.IsSuccess || planBody?.Error is not null)
        {
            return RenderPlanFailure(
                planBody?.Error,
                "Failed to create app install plan.",
                planResponse.StatusCode,
                planResponse.RawBody);
        }

        var plan = planBody?.Plan;
        if (plan is null)
        {
            return RenderApiFailure("Install plan response did not include a plan.", planResponse.StatusCode, planResponse.RawBody);
        }

        if (plan.Conflicts.Count > 0)
        {
            RenderConflicts(plan.Conflicts);
            context.Console.MarkupLine("[red]Install is blocked by conflicts.[/]");
            return 1;
        }

        var settings = PromptForSettings(plan.Settings);
        var externalMounts = PromptForExternalMounts(plan.Storage.MountCollections);
        var request = new ModuleInstallRequest
        {
            MetadataUrl = plan.MetadataUrl,
            PlanDigest = plan.PlanDigest,
            Settings = settings,
            ExternalMounts = externalMounts,
        };

        RenderRequestPreview(RedactInstallRequest(request));
        if (!Confirm("Apply this app install?"))
        {
            context.Console.MarkupLine("[yellow]Install cancelled.[/]");
            return 130;
        }

        var applyResponse = await CommandStatus.RunAsync(
            context,
            $"Installing app [grey]{Markup.Escape(plan.Module.Id)}[/]...",
            async () => await hostApi.ApplyInstallAsync(request));
        var applyBody = applyResponse.Body;
        if (!applyResponse.IsSuccess || applyBody?.Error is not null)
        {
            return RenderPlanFailure(
                applyBody?.Error,
                "Failed to install app.",
                applyResponse.StatusCode,
                applyResponse.RawBody);
        }

        context.Console.MarkupLine("[green]App install completed.[/]");
        if (applyBody is not null)
        {
            RenderStringList("Installed", applyBody.InstalledModuleIds);
            RenderStringList("Reused", applyBody.ReusedModuleIds);
            if (applyBody.Module is not null)
            {
                RenderModuleSummary(applyBody.Module);
            }
        }

        return 0;
    }

    private async Task<int> ListBackupsAsync(string[] args)
    {
        EnsureAppsCommand("backups <app-id>");
        if (args.Length != 1)
        {
            throw new CommandUsageException("apps backups requires exactly one app id.", "Usage: hosty apps backups <app-id>");
        }

        using var hostApi = await CreateHostControlClientAsync();
        if (hostApi is null)
        {
            return 1;
        }

        var response = await hostApi.ListAppBackupsAsync(args[0]);
        if (!response.IsSuccess || response.Body is null)
        {
            return RenderApiFailure("Failed to list app backups.", response.StatusCode, response.RawBody);
        }

        if (response.Body.Backups.Count == 0)
        {
            context.Console.MarkupLine("[yellow]No app data backups.[/]");
            return 0;
        }

        RenderBackups(response.Body.Backups);
        return 0;
    }

    private async Task<int> CreateBackupAsync(string[] args)
    {
        EnsureAppsCommand("backup <app-id>");
        if (args.Length != 1)
        {
            throw new CommandUsageException("apps backup requires exactly one app id.", "Usage: hosty apps backup <app-id>");
        }

        using var hostApi = await CreateHostControlClientAsync();
        if (hostApi is null)
        {
            return 1;
        }

        var response = await CommandStatus.RunAsync(
            context,
            $"Creating app data backup [grey]{Markup.Escape(args[0])}[/]...",
            async () => await hostApi.CreateAppBackupAsync(args[0]));
        if (!response.IsSuccess || response.Body?.Backup is null)
        {
            return RenderApiFailure("Failed to create app backup.", response.StatusCode, response.RawBody);
        }

        context.Console.MarkupLine("[green]App data backup created.[/]");
        RenderBackup(response.Body.Backup);
        return 0;
    }

    private async Task<int> RestoreBackupAsync(string[] args)
    {
        EnsureAppsCommand("restore <app-id> <backup-id>");
        if (args.Length != 2)
        {
            throw new CommandUsageException("apps restore requires an app id and backup id.", "Usage: hosty apps restore <app-id> <backup-id>");
        }

        var appId = args[0];
        var backupId = args[1];
        if (!Confirm($"Restore backup {backupId} for app {appId}? The app will be stopped first."))
        {
            context.Console.MarkupLine("[yellow]Restore cancelled.[/]");
            return 130;
        }

        using var hostApi = await CreateHostControlClientAsync();
        if (hostApi is null)
        {
            return 1;
        }

        var response = await CommandStatus.RunAsync(
            context,
            $"Restoring app data backup [grey]{Markup.Escape(backupId)}[/]...",
            async () => await hostApi.RestoreAppBackupAsync(appId, backupId, new AppRestoreRequest
            {
                Confirmed = true,
                StopBeforeRestore = true,
                CreatePreRestoreBackup = true,
            }));
        if (!response.IsSuccess || response.Body?.Restored is null)
        {
            return RenderApiFailure("Failed to restore app backup.", response.StatusCode, response.RawBody);
        }

        context.Console.MarkupLine("[green]App data backup restored.[/]");
        RenderBackup(response.Body.Restored);
        if (response.Body.PreRestoreBackup is not null)
        {
            context.Console.MarkupLine("[grey]Pre-restore backup:[/]");
            RenderBackup(response.Body.PreRestoreBackup);
        }

        return 0;
    }

    private async Task<int> RunLifecycleActionAsync(string action, string[] args)
    {
        if (args.Length != 1)
        {
            throw new CommandUsageException(
                $"{commandName} {action} requires exactly one app id.",
                $"Usage: hosty {commandName} {action} <app-id>");
        }

        using var hostApi = await CreateHostControlClientAsync();
        if (hostApi is null)
        {
            return 1;
        }

        if (!await EnsureHostReadyAsync(hostApi))
        {
            return 1;
        }

        var moduleId = args[0];
        var statusVerb = action switch
        {
            "start" => "Starting",
            "stop" => "Stopping",
            "restart" => "Restarting",
            _ => "Running",
        };
        var response = await CommandStatus.RunAsync(
            context,
            $"{statusVerb} app [grey]{Markup.Escape(moduleId)}[/]...",
            async () => await hostApi.RunModuleActionAsync(moduleId, action));
        var body = response.Body;
        if (!response.IsSuccess || body?.Success != true)
        {
            RenderModuleOperationError(body?.Error, $"Failed to {action} app.", response.StatusCode, response.RawBody);
            return response.StatusCode == HttpStatusCode.UnprocessableEntity ? 2 : 1;
        }

        context.Console.MarkupLine($"[green]App {Markup.Escape(action)} completed.[/]");
        if (body.Module is not null)
        {
            RenderModuleSummary(body.Module);
        }

        return 0;
    }

    private async Task<int> UpdateAsync(string[] args)
    {
        if (args.Length != 1)
        {
            throw new CommandUsageException(
                $"{commandName} update requires exactly one app id.",
                $"Usage: hosty {commandName} update <app-id>");
        }

        using var hostApi = await CreateHostControlClientAsync();
        if (hostApi is null)
        {
            return 1;
        }

        if (!await EnsureHostReadyAsync(hostApi))
        {
            return 1;
        }

        var moduleId = args[0];
        var planResponse = await hostApi.CreateUpdatePlanAsync(moduleId);
        var planBody = planResponse.Body;
        if (planBody?.Plan is not null)
        {
            RenderUpdatePlan(planBody.Plan);
        }

        if (!planResponse.IsSuccess || planBody?.Error is not null)
        {
            return RenderPlanFailure(
                planBody?.Error,
                "Failed to create app update plan.",
                planResponse.StatusCode,
                planResponse.RawBody);
        }

        var plan = planBody?.Plan;
        if (plan is null)
        {
            return RenderApiFailure("Update plan response did not include a plan.", planResponse.StatusCode, planResponse.RawBody);
        }

        if (plan.Conflicts.Count > 0)
        {
            RenderConflicts(plan.Conflicts);
            context.Console.MarkupLine("[red]Update is blocked by conflicts.[/]");
            return 1;
        }

        return await ApplyReviewedUpdatePlanAsync(hostApi, plan);
    }

    private async Task<int> ApplyReviewedUpdatePlanAsync(HostControlClient hostApi, ModuleUpdatePlan plan)
    {
        var settings = PromptForSettings(plan.Settings);
        var externalMounts = PromptForExternalMounts(plan.Storage.MountCollections);
        var request = new ModuleUpdateRequest
        {
            UpdatePlanDigest = plan.UpdatePlanDigest,
            Confirmed = true,
            Settings = settings,
            ExternalMounts = externalMounts,
        };

        RenderRequestPreview(RedactUpdateRequest(request));
        if (!Confirm("Apply this app update?"))
        {
            context.Console.MarkupLine("[yellow]Update cancelled.[/]");
            return 130;
        }

        var applyResponse = await CommandStatus.RunAsync(
            context,
            $"Updating app [grey]{Markup.Escape(plan.ModuleId)}[/]...",
            async () => await hostApi.ApplyUpdateAsync(plan.ModuleId, request));
        var applyBody = applyResponse.Body;
        if (!applyResponse.IsSuccess || applyBody?.Error is not null)
        {
            return RenderPlanFailure(
                applyBody?.Error,
                "Failed to update app.",
                applyResponse.StatusCode,
                applyResponse.RawBody);
        }

        context.Console.MarkupLine("[green]App update completed.[/]");
        if (applyBody is not null)
        {
            if (!string.IsNullOrWhiteSpace(applyBody.UpdatedModuleId))
            {
                context.Console.MarkupLine($"[grey]Updated:[/] {Markup.Escape(applyBody.UpdatedModuleId)}");
            }

            RenderStringList("Installed dependencies", applyBody.InstalledDependencyIds);
            RenderStringList("Reused dependencies", applyBody.ReusedDependencyIds);
            if (applyBody.Module is not null)
            {
                RenderModuleSummary(applyBody.Module);
            }
        }

        return 0;
    }

    private async Task<int> RemoveAsync(string[] args)
    {
        var parsed = ParseArguments(args);
        if (parsed.Positionals.Count != 1)
        {
            throw new CommandUsageException(
                $"{commandName} remove requires exactly one app id.",
                $"Usage: hosty {commandName} remove <app-id> [--delete-data]");
        }

        using var hostApi = await CreateHostControlClientAsync();
        if (hostApi is null)
        {
            return 1;
        }

        if (!await EnsureHostReadyAsync(hostApi))
        {
            return 1;
        }

        var moduleId = parsed.Positionals[0];
        var deleteData = parsed.Flags.Contains("delete-data");
        var planResponse = await hostApi.CreateRemovePlanAsync(moduleId, new ModuleRemovePlanRequest
        {
            DeleteModuleData = deleteData,
        });
        var planBody = planResponse.Body;
        if (planBody?.Plan is not null)
        {
            RenderRemovePlan(planBody.Plan);
        }

        if (!planResponse.IsSuccess || planBody?.Error is not null)
        {
            return RenderPlanFailure(
                planBody?.Error,
                "Failed to create app remove plan.",
                planResponse.StatusCode,
                planResponse.RawBody);
        }

        var plan = planBody?.Plan;
        if (plan is null)
        {
            return RenderApiFailure("Remove plan response did not include a plan.", planResponse.StatusCode, planResponse.RawBody);
        }

        if (!plan.CanApply || plan.Conflicts.Count > 0)
        {
            RenderConflicts(plan.Conflicts);
            context.Console.MarkupLine("[red]Remove is blocked by conflicts.[/]");
            return 1;
        }

        if (!Confirm(deleteData ? "Remove this app and delete its app-owned data?" : "Remove this app?"))
        {
            context.Console.MarkupLine("[yellow]Remove cancelled.[/]");
            return 130;
        }

        var applyResponse = await CommandStatus.RunAsync(
            context,
            $"Removing app [grey]{Markup.Escape(moduleId)}[/]...",
            async () => await hostApi.ApplyRemoveAsync(moduleId, new ModuleRemoveRequest
            {
                Confirmed = true,
                DeleteModuleData = deleteData,
            }));
        var body = applyResponse.Body;
        if (!applyResponse.IsSuccess || body?.Success != true)
        {
            RenderModuleOperationError(body?.Error, "Failed to remove app.", applyResponse.StatusCode, applyResponse.RawBody);
            return 1;
        }

        context.Console.MarkupLine("[green]App remove completed.[/]");
        return 0;
    }

    private async Task<HostControlClient?> CreateHostControlClientAsync()
    {
        var settings = context.SettingsStore.Load();
        settings.Validate(context.Environment);

        using var docker = context.DockerFactory.Create(settings.HostDockerEndpoint);
        var container = await docker.InspectContainerAsync(settings.HostContainerName);
        if (container is null)
        {
            context.Console.MarkupLine("[red]Host container does not exist.[/]");
            context.Console.WriteLine("Run hosty start first.");
            return null;
        }

        if (container.State?.Running != true)
        {
            context.Console.MarkupLine("[red]Host container is not running.[/]");
            context.Console.WriteLine("Run hosty start first.");
            return null;
        }

        var url = HostLifecycle.TryGetHostUrl(container, settings);
        if (url is null)
        {
            context.Console.MarkupLine("[red]Unable to determine the Host API URL from Docker container metadata.[/]");
            context.Console.WriteLine("Run hosty status and hosty start to inspect or recreate the Host container.");
            return null;
        }

        try
        {
            var discovery = HostControlDiscovery.Load(settings.ResolveHostDataRoot(context.Environment));
            var endpoint = new Uri(new Uri(url), "/control/v1/");
            return context.ControlFactory.Create(endpoint, discovery.Secret);
        }
        catch (HostApiException ex)
        {
            context.Console.MarkupLine("[red]Trusted local control channel is not available.[/]");
            if (!string.IsNullOrWhiteSpace(ex.Message))
            {
                context.Console.WriteLine(ex.Message);
            }

            if (!string.IsNullOrWhiteSpace(ex.NextStep))
            {
                context.Console.WriteLine(ex.NextStep);
            }

            return null;
        }
    }

    private async Task<bool> EnsureHostReadyAsync(HostControlClient hostApi)
    {
        var response = await hostApi.GetHostStatusAsync();
        if (response.IsSuccess)
        {
            return true;
        }

        context.Console.MarkupLine("[red]Host is not ready.[/]");
        if (!string.IsNullOrWhiteSpace(response.RawBody))
        {
            context.Console.WriteLine(response.RawBody);
        }

        return false;
    }

    private void RenderInstallPlan(InstallPlan plan)
    {
        context.Console.MarkupLine("[bold]Install plan[/]");
        var table = new Table()
            .RoundedBorder()
            .AddColumn("Property")
            .AddColumn("Value");

        table.AddRow("Module", Markup.Escape($"{plan.Module.Name} ({plan.Module.Id})"));
        table.AddRow("Version", Markup.Escape(plan.Module.Version));
        table.AddRow("Metadata digest", Markup.Escape(plan.MetadataDigest));
        table.AddRow("Plan digest", Markup.Escape(plan.PlanDigest));
        table.AddRow("Container", Markup.Escape(plan.Docker.ContainerName));
        table.AddRow("Network", Markup.Escape(plan.Docker.NetworkName));
        context.Console.Write(table);

        RenderDependencies(plan.Dependencies);
        RenderImages(plan.Images);
        RenderStorage(plan.Storage);
        RenderSettings(plan.Settings);
        RenderRuntime(plan.Runtime.Ports);
        RenderConflicts(plan.Conflicts);
    }

    private void RenderUpdatePlan(ModuleUpdatePlan plan)
    {
        context.Console.MarkupLine("[bold]Update plan[/]");
        var table = new Table()
            .RoundedBorder()
            .AddColumn("Property")
            .AddColumn("Value");

        table.AddRow("Module", Markup.Escape($"{plan.Module.ProposedName} ({plan.ModuleId})"));
        table.AddRow("Version", Markup.Escape($"{plan.Module.CurrentVersion} -> {plan.Module.ProposedVersion}"));
        table.AddRow("Current metadata", Markup.Escape(plan.CurrentMetadataDigest ?? ""));
        table.AddRow("Refreshed metadata", Markup.Escape(plan.RefreshedMetadataDigest));
        table.AddRow("Update digest", Markup.Escape(plan.UpdatePlanDigest));
        table.AddRow("Replacement", plan.Docker.ReplacementRequired ? "yes" : "no");
        context.Console.Write(table);

        RenderChanges(plan.Changes);
        RenderWarnings(plan.Warnings);
        RenderImages(plan.Images);
        RenderStorage(plan.Storage);
        RenderSettings(plan.Settings);
        RenderConflicts(plan.Conflicts);
    }

    private void RenderRemovePlan(ModuleRemovePlan plan)
    {
        context.Console.MarkupLine("[bold]Remove plan[/]");
        var table = new Table()
            .RoundedBorder()
            .AddColumn("Property")
            .AddColumn("Value");

        table.AddRow("Module", Markup.Escape($"{plan.ModuleName} ({plan.ModuleId})"));
        table.AddRow("Can apply", plan.CanApply ? "yes" : "no");
        table.AddRow("Delete module data", plan.DeleteModuleData ? "yes" : "no");
        context.Console.Write(table);

        if (plan.Containers.Count > 0)
        {
            var containers = new Table()
                .RoundedBorder()
                .Title("Containers")
                .AddColumn("Key")
                .AddColumn("Name")
                .AddColumn("Exists")
                .AddColumn("Will remove");

            foreach (var container in plan.Containers)
            {
                containers.AddRow(
                    Markup.Escape(container.Key),
                    Markup.Escape(container.Name),
                    container.Exists ? "yes" : "no",
                    container.WillRemove ? "yes" : "no");
            }

            context.Console.Write(containers);
        }

        RenderWarnings(plan.Warnings);
        RenderConflicts(plan.Conflicts);
    }

    private void RenderDependencies(IReadOnlyList<InstallPlanDependencyNode> dependencies)
    {
        if (dependencies.Count == 0)
        {
            return;
        }

        var table = new Table()
            .RoundedBorder()
            .Title("Dependencies")
            .AddColumn("Module")
            .AddColumn("Version")
            .AddColumn("Action")
            .AddColumn("Container")
            .AddColumn("Required by");

        foreach (var dependency in dependencies)
        {
            table.AddRow(
                Markup.Escape($"{dependency.Name} ({dependency.Id})"),
                Markup.Escape(dependency.Version),
                Markup.Escape(dependency.InstallAction),
                Markup.Escape(dependency.Docker.ContainerName),
                Markup.Escape(string.Join(", ", dependency.RequiredBy)));
        }

        context.Console.Write(table);
    }

    private void RenderImages(IReadOnlyList<InstallPlanImage> images)
    {
        if (images.Count == 0)
        {
            return;
        }

        var table = new Table()
            .RoundedBorder()
            .Title("Images")
            .AddColumn("Module")
            .AddColumn("Image")
            .AddColumn("Pull policy");

        foreach (var image in images)
        {
            table.AddRow(
                Markup.Escape(image.ModuleId),
                Markup.Escape(image.Reference),
                Markup.Escape(image.PullPolicy));
        }

        context.Console.Write(table);
    }

    private void RenderStorage(InstallPlanStorage storage)
    {
        if (storage.Directories.Count > 0)
        {
            var table = new Table()
                .RoundedBorder()
                .Title("Storage directories")
                .AddColumn("Module")
                .AddColumn("Key")
                .AddColumn("Host path")
                .AddColumn("Container path")
                .AddColumn("Mode");

            foreach (var directory in storage.Directories)
            {
                table.AddRow(
                    Markup.Escape(directory.ModuleId),
                    Markup.Escape(directory.Key),
                    Markup.Escape(directory.HostPath),
                    Markup.Escape(directory.ContainerPath),
                    directory.ReadOnly ? "readOnly" : "readWrite");
            }

            context.Console.Write(table);
        }

        if (storage.MountCollections.Count > 0)
        {
            var table = new Table()
                .RoundedBorder()
                .Title("External mount collections")
                .AddColumn("Module")
                .AddColumn("Collection")
                .AddColumn("Required")
                .AddColumn("Items")
                .AddColumn("Template");

            foreach (var collection in storage.MountCollections)
            {
                var max = collection.MaxItems is null ? "unbounded" : collection.MaxItems.ToString();
                table.AddRow(
                    Markup.Escape(collection.ModuleId),
                    Markup.Escape(collection.Label ?? collection.Key),
                    collection.Required ? "yes" : "no",
                    Markup.Escape($"{collection.MinItems}..{max}"),
                    Markup.Escape(collection.ItemContainerPathTemplate));
            }

            context.Console.Write(table);
        }
    }

    private void RenderSettings(IReadOnlyList<InstallPlanSettingPrompt> settings)
    {
        if (settings.Count == 0)
        {
            return;
        }

        var table = new Table()
            .RoundedBorder()
            .Title("Settings")
            .AddColumn("Module")
            .AddColumn("Key")
            .AddColumn("Type")
            .AddColumn("Required")
            .AddColumn("Target");

        foreach (var setting in settings)
        {
            table.AddRow(
                Markup.Escape(setting.ModuleId),
                Markup.Escape(setting.Key),
                Markup.Escape(setting.Secret ? "secret" : setting.Type),
                setting.Required ? "yes" : "no",
                Markup.Escape(setting.Target.Name));
        }

        context.Console.Write(table);
    }

    private void RenderRuntime(IReadOnlyList<InstallPlanRuntimePort> ports)
    {
        if (ports.Count == 0)
        {
            return;
        }

        var table = new Table()
            .RoundedBorder()
            .Title("Runtime ports")
            .AddColumn("Key")
            .AddColumn("Container port")
            .AddColumn("Protocol")
            .AddColumn("Public");

        foreach (var port in ports)
        {
            table.AddRow(
                Markup.Escape(port.Key),
                port.ContainerPort.ToString(CultureInfo.InvariantCulture),
                Markup.Escape(port.Protocol),
                port.Public ? "yes" : "no");
        }

        context.Console.Write(table);
    }

    private void RenderChanges(IReadOnlyList<ModuleUpdateChange> changes)
    {
        if (changes.Count == 0)
        {
            return;
        }

        var table = new Table()
            .RoundedBorder()
            .Title("Changes")
            .AddColumn("Category")
            .AddColumn("Action")
            .AddColumn("Module")
            .AddColumn("Title");

        foreach (var change in changes)
        {
            table.AddRow(
                Markup.Escape(change.Category),
                Markup.Escape(change.Action),
                Markup.Escape(change.ModuleId),
                Markup.Escape(change.Title));
        }

        context.Console.Write(table);
    }

    private void RenderWarnings(IReadOnlyList<string> warnings)
    {
        foreach (var warning in warnings)
        {
            context.Console.MarkupLine($"[yellow]Warning:[/] {Markup.Escape(warning)}");
        }
    }

    private void RenderConflicts(IReadOnlyList<InstallPlanConflict> conflicts)
    {
        if (conflicts.Count == 0)
        {
            return;
        }

        var table = new Table()
            .RoundedBorder()
            .Title("Conflicts")
            .AddColumn("Code")
            .AddColumn("Resource")
            .AddColumn("Path")
            .AddColumn("Message");

        foreach (var conflict in conflicts)
        {
            table.AddRow(
                Markup.Escape(conflict.Code),
                Markup.Escape($"{conflict.ResourceType}:{conflict.ResourceId}"),
                Markup.Escape(conflict.Path),
                Markup.Escape(conflict.Message));
        }

        context.Console.Write(table);
    }

    private IReadOnlyList<ModuleInstallSettingSelection> PromptForSettings(IReadOnlyList<InstallPlanSettingPrompt> settings)
    {
        if (settings.Count == 0)
        {
            return [];
        }

        var selections = new List<ModuleInstallSettingSelection>();
        context.Console.MarkupLine("[bold]Settings[/]");
        foreach (var setting in settings)
        {
            var rawValue = PromptForSetting(setting);
            if (rawValue is null)
            {
                continue;
            }

            selections.Add(new ModuleInstallSettingSelection
            {
                ModuleId = setting.ModuleId,
                Key = setting.Key,
                Secret = setting.Secret,
                Value = CoerceSettingValue(setting, rawValue),
            });
        }

        return selections;
    }

    private string? PromptForSetting(InstallPlanSettingPrompt setting)
    {
        var prompt = CreateSettingPrompt(setting);
        var raw = context.Console.Prompt(prompt);
        return string.IsNullOrEmpty(raw) && !setting.Required ? null : raw;
    }

    internal static TextPrompt<string> CreateSettingPrompt(InstallPlanSettingPrompt setting)
    {
        var label = $"{setting.ModuleId}.{setting.Key}";
        var prompt = new TextPrompt<string>($"{Markup.Escape(label)} ({Markup.Escape(setting.Secret ? "secret" : setting.Type)}):")
            .WithConverter(Markup.Escape);
        if (!setting.Required)
        {
            prompt.AllowEmpty();
        }

        if (setting.Secret)
        {
            prompt.Secret();
        }
        else if (TryFormatJsonValue(setting.Default, out var defaultValue))
        {
            prompt.DefaultValue(defaultValue);
        }

        prompt.Validate(value => ValidateSettingInput(setting, value));
        return prompt;
    }

    private IReadOnlyList<ModuleInstallExternalMountSelection> PromptForExternalMounts(IReadOnlyList<InstallPlanMountCollection> collections)
    {
        if (collections.Count == 0)
        {
            return [];
        }

        var selections = new List<ModuleInstallExternalMountSelection>();
        context.Console.MarkupLine("[bold]External mounts[/]");
        foreach (var collection in collections)
        {
            var minimum = collection.Required ? collection.MinItems : 0;
            var count = PromptForMountCount(collection, minimum);
            for (var index = 0; index < count; index++)
            {
                selections.Add(PromptForExternalMount(collection, index + 1));
            }
        }

        return selections;
    }

    private int PromptForMountCount(InstallPlanMountCollection collection, int minimum)
    {
        var maximumText = collection.MaxItems is null
            ? "unbounded"
            : collection.MaxItems.Value.ToString(CultureInfo.InvariantCulture);
        var prompt = new TextPrompt<string>(
            $"{Markup.Escape(collection.ModuleId)}.{Markup.Escape(collection.Key)} mount count ({minimum}..{maximumText}):")
            .DefaultValue(minimum.ToString(CultureInfo.InvariantCulture))
            .Validate(value =>
            {
                if (!int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var count))
                {
                    return ValidationResult.Error("Enter a whole number.");
                }

                if (count < minimum)
                {
                    return ValidationResult.Error($"Enter at least {minimum}.");
                }

                if (collection.MaxItems is not null && count > collection.MaxItems.Value)
                {
                    return ValidationResult.Error($"Enter at most {collection.MaxItems.Value}.");
                }

                return ValidationResult.Success();
            });

        return int.Parse(context.Console.Prompt(prompt), CultureInfo.InvariantCulture);
    }

    private ModuleInstallExternalMountSelection PromptForExternalMount(InstallPlanMountCollection collection, int ordinal)
    {
        context.Console.MarkupLine($"[grey]{Markup.Escape(collection.ModuleId)}.{Markup.Escape(collection.Key)} item {ordinal}[/]");
        var key = context.Console.Prompt(
            new TextPrompt<string>("Item key:")
                .Validate(value => IsSafeExternalMountKey(value)
                    ? ValidationResult.Success()
                    : ValidationResult.Error("Item key must be a safe path segment.")));
        var label = context.Console.Prompt(new TextPrompt<string>("Label:").AllowEmpty());
        var hostPath = context.Console.Prompt(
            new TextPrompt<string>("Host path:")
                .Validate(value => string.IsNullOrWhiteSpace(value)
                    ? ValidationResult.Error("Host path is required.")
                    : ValidationResult.Success()));
        var access = collection.Writable
            ? context.Console.Prompt(
                new SelectionPrompt<string>()
                    .Title("Access:")
                    .AddChoices("readWrite", "readOnly"))
            : "readOnly";

        return new ModuleInstallExternalMountSelection
        {
            ModuleId = collection.ModuleId,
            CollectionKey = collection.Key,
            Key = key,
            Label = string.IsNullOrWhiteSpace(label) ? null : label,
            HostPath = hostPath,
            ContainerPath = ComputeExternalMountContainerPath(collection, key),
            Access = access,
        };
    }

    private static object CoerceSettingValue(InstallPlanSettingPrompt setting, string rawValue)
    {
        if (string.Equals(setting.Type, "number", StringComparison.OrdinalIgnoreCase))
        {
            return rawValue.Contains('.', StringComparison.Ordinal)
                ? double.Parse(rawValue, NumberStyles.Float, CultureInfo.InvariantCulture)
                : long.Parse(rawValue, NumberStyles.Integer, CultureInfo.InvariantCulture);
        }

        if (string.Equals(setting.Type, "boolean", StringComparison.OrdinalIgnoreCase))
        {
            return bool.Parse(rawValue);
        }

        return rawValue;
    }

    private static ValidationResult ValidateSettingInput(InstallPlanSettingPrompt setting, string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return setting.Required
                ? ValidationResult.Error("Value is required.")
                : ValidationResult.Success();
        }

        if (string.Equals(setting.Type, "number", StringComparison.OrdinalIgnoreCase) &&
            !double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out _))
        {
            return ValidationResult.Error("Enter a number.");
        }

        if (string.Equals(setting.Type, "boolean", StringComparison.OrdinalIgnoreCase) &&
            !bool.TryParse(value, out _))
        {
            return ValidationResult.Error("Enter true or false.");
        }

        return ValidationResult.Success();
    }

    private static bool IsSafeExternalMountKey(string value)
        => value.Length > 0 &&
            value is not "." and not ".." &&
            value[0] is >= 'a' and <= 'z' or >= '0' and <= '9' &&
            value.All(character =>
                character is >= 'a' and <= 'z' ||
                character is >= '0' and <= '9' ||
                character is '.' or '_' or '-') &&
            !value.Contains('/') &&
            !value.Contains('\\') &&
            !value.Contains('\0');

    private static string ComputeExternalMountContainerPath(InstallPlanMountCollection collection, string key)
        => collection.ItemContainerPathTemplate.Replace("{key}", key, StringComparison.Ordinal);

    private void RenderRequestPreview(object request)
    {
        context.Console.MarkupLine("[bold]Request preview[/]");
        context.Console.WriteLine(JsonSerializer.Serialize(request, PreviewJsonOptions));
    }

    private bool Confirm(string message)
        => context.Console.Prompt(new ConfirmationPrompt(message) { DefaultValue = false });

    private static ModuleInstallRequest RedactInstallRequest(ModuleInstallRequest request)
        => new()
        {
            MetadataUrl = request.MetadataUrl,
            PlanDigest = request.PlanDigest,
            Settings = RedactSettings(request.Settings),
            ExternalMounts = request.ExternalMounts,
        };

    private static ModuleUpdateRequest RedactUpdateRequest(ModuleUpdateRequest request)
        => new()
        {
            UpdatePlanDigest = request.UpdatePlanDigest,
            Confirmed = request.Confirmed,
            Settings = RedactSettings(request.Settings),
            ExternalMounts = request.ExternalMounts,
        };

    private static IReadOnlyList<ModuleInstallSettingSelection> RedactSettings(IReadOnlyList<ModuleInstallSettingSelection> settings)
        => settings.Select(setting => new ModuleInstallSettingSelection
        {
            ModuleId = setting.ModuleId,
            Key = setting.Key,
            Secret = setting.Secret,
            Value = setting.Secret ? "<redacted>" : setting.Value,
        }).ToArray();

    private int RenderPlanFailure(
        InstallPlanErrorEnvelope? error,
        string fallback,
        HttpStatusCode statusCode,
        string rawBody)
    {
        if (error is null)
        {
            return RenderApiFailure(fallback, statusCode, rawBody);
        }

        context.Console.MarkupLine($"[red]{Markup.Escape(error.Message)}[/]");
        RenderValidationErrors(error.ValidationErrors);
        RenderConflicts(error.Conflicts);
        return statusCode == HttpStatusCode.UnprocessableEntity ? 2 : 1;
    }

    private int RenderApiFailure(string fallback, HttpStatusCode statusCode, string rawBody)
    {
        context.Console.MarkupLine($"[red]{Markup.Escape(fallback)}[/]");
        context.Console.MarkupLine($"[grey]HTTP status:[/] {(int)statusCode} {statusCode}");
        if (!string.IsNullOrWhiteSpace(rawBody))
        {
            context.Console.WriteLine(rawBody);
        }

        return statusCode == HttpStatusCode.UnprocessableEntity ? 2 : 1;
    }

    private void EnsureAppsCommand(string actionUsage)
    {
        if (!string.Equals(commandName, "apps", StringComparison.Ordinal))
        {
            throw new CommandUsageException(
                $"Use hosty apps {actionUsage} for app data backups.",
                $"Usage: hosty apps {actionUsage}");
        }
    }

    private void RenderValidationErrors(IReadOnlyList<InstallPlanValidationError> validationErrors)
    {
        if (validationErrors.Count == 0)
        {
            return;
        }

        var table = new Table()
            .RoundedBorder()
            .Title("Validation errors")
            .AddColumn("Code")
            .AddColumn("Path")
            .AddColumn("Node")
            .AddColumn("Message");

        foreach (var error in validationErrors)
        {
            table.AddRow(
                Markup.Escape(error.Code),
                Markup.Escape(error.Path),
                Markup.Escape(error.Node ?? ""),
                Markup.Escape(error.Message));
        }

        context.Console.Write(table);
    }

    private void RenderModuleOperationError(
        ModuleOperationError? error,
        string fallback,
        HttpStatusCode statusCode,
        string rawBody)
    {
        context.Console.MarkupLine($"[red]{Markup.Escape(error?.Message ?? fallback)}[/]");
        if (!string.IsNullOrWhiteSpace(error?.DockerMessage))
        {
            context.Console.MarkupLine($"[grey]Docker message:[/] {Markup.Escape(error.DockerMessage)}");
        }

        if (!string.IsNullOrWhiteSpace(error?.NextStep))
        {
            context.Console.MarkupLine($"[grey]Next step:[/] {Markup.Escape(error.NextStep)}");
        }

        if (error is null && !string.IsNullOrWhiteSpace(rawBody))
        {
            context.Console.MarkupLine($"[grey]HTTP status:[/] {(int)statusCode} {statusCode}");
            context.Console.WriteLine(rawBody);
        }
    }

    private void RenderModuleSummary(ModuleSummary module)
    {
        var table = new Table()
            .RoundedBorder()
            .AddColumn("Property")
            .AddColumn("Value");

        table.AddRow("Module", Markup.Escape(FormatModuleLabel(module)));
        table.AddRow("Version", Markup.Escape(module.Version));
        table.AddRow("Operation", Markup.Escape(module.OperationStatus));
        table.AddRow("Runtime", Markup.Escape(module.RuntimeStatus?.State ?? "unknown"));
        table.AddRow("Container", Markup.Escape(module.RuntimeStatus?.ContainerName ?? ""));
        table.AddRow("Image", Markup.Escape(module.Image?.Reference ?? ""));
        context.Console.Write(table);
    }

    private void RenderBackups(IReadOnlyList<AppBackupSummary> backups)
    {
        var table = new Table()
            .RoundedBorder()
            .AddColumn("Backup")
            .AddColumn("Reason")
            .AddColumn("Created")
            .AddColumn("Files")
            .AddColumn("Bytes");

        foreach (var backup in backups)
        {
            table.AddRow(
                Markup.Escape(backup.Id),
                Markup.Escape(backup.Reason),
                Markup.Escape(backup.CreatedAt),
                backup.FileCount.ToString(CultureInfo.InvariantCulture),
                backup.ArchiveBytes.ToString(CultureInfo.InvariantCulture));
        }

        context.Console.Write(table);
    }

    private void RenderBackup(AppBackupSummary backup)
    {
        context.Console.MarkupLine($"[bold]Backup:[/] {Markup.Escape(backup.Id)}");
        context.Console.MarkupLine($"[bold]App:[/] {Markup.Escape(backup.AppId)}");
        context.Console.MarkupLine($"[bold]Reason:[/] {Markup.Escape(backup.Reason)}");
        context.Console.MarkupLine($"[bold]Created:[/] {Markup.Escape(backup.CreatedAt)}");
        context.Console.MarkupLine($"[bold]Files:[/] {backup.FileCount.ToString(CultureInfo.InvariantCulture)}");
        context.Console.MarkupLine($"[bold]Archive:[/] {Markup.Escape(backup.ArchivePath)}");
        context.Console.MarkupLine($"[bold]Digest:[/] {Markup.Escape(backup.ArchiveDigest)}");
    }

    private void RenderStringList(string label, IReadOnlyList<string> values)
    {
        if (values.Count == 0)
        {
            return;
        }

        context.Console.MarkupLine($"[grey]{Markup.Escape(label)}:[/] {Markup.Escape(string.Join(", ", values))}");
    }

    private static string FormatModuleLabel(ModuleSummary module)
        => string.IsNullOrWhiteSpace(module.Name)
            ? module.Id
            : $"{module.Name} ({module.Id})";

    internal static string FormatModuleImageTags(ModuleSummary module)
    {
        var tags = module.Containers.Count > 0
            ? module.Containers
                .Select(container => FormatImageTag(container.Image))
                .Where(tag => !string.IsNullOrWhiteSpace(tag))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            : new[] { FormatImageTag(module.Image) };

        return string.Join(", ", tags.Where(tag => !string.IsNullOrWhiteSpace(tag)));
    }

    private static string FormatImageTag(ModuleImage? image)
    {
        if (image is null)
        {
            return "";
        }

        if (!string.IsNullOrWhiteSpace(image.Tag))
        {
            return image.Tag;
        }

        return TryReadTagFromImageReference(image.Reference);
    }

    private static string TryReadTagFromImageReference(string reference)
    {
        if (string.IsNullOrWhiteSpace(reference) || reference.Contains('@', StringComparison.Ordinal))
        {
            return "";
        }

        var slashIndex = reference.LastIndexOf('/');
        var colonIndex = reference.LastIndexOf(':');

        return colonIndex > slashIndex && colonIndex < reference.Length - 1
            ? reference[(colonIndex + 1)..]
            : "";
    }

    private static bool TryFormatJsonValue(JsonElement? element, out string value)
    {
        value = "";
        if (element is null || element.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return false;
        }

        value = element.Value.ValueKind switch
        {
            JsonValueKind.String => element.Value.GetString() ?? "",
            JsonValueKind.Number => element.Value.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => element.Value.GetRawText(),
        };
        return true;
    }

    private ParsedArguments ParseArguments(string[] args)
    {
        var positionals = new List<string>();
        var options = new Dictionary<string, string>(StringComparer.Ordinal);
        var flags = new HashSet<string>(StringComparer.Ordinal);

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

            if (option is "disabled" or "delete-data")
            {
                flags.Add(option);
                continue;
            }

            if (index + 1 >= args.Length || args[index + 1].StartsWith("--", StringComparison.Ordinal))
            {
                throw new CommandUsageException($"Option '{arg}' requires a value.", Usage);
            }

            options[option] = args[++index];
        }

        return new ParsedArguments(positionals, options, flags);
    }

    private sealed record ParsedArguments(
        IReadOnlyList<string> Positionals,
        IReadOnlyDictionary<string, string> Options,
        IReadOnlySet<string> Flags);
}
