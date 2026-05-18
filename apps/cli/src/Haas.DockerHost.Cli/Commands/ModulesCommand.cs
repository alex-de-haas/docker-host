namespace Haas.DockerHost.Cli.Commands;

using System.Globalization;
using System.Net;
using System.Text.Json;
using Haas.DockerHost.Cli.Configuration;
using Haas.DockerHost.Cli.HostApi;
using Spectre.Console;

internal sealed class ModulesCommand(CommandContext context)
{
    private const string Usage = """
        Usage:
          docker-host modules list
          docker-host modules install <metadata-url>
          docker-host modules add <metadata-url>
          docker-host modules start <module-id>
          docker-host modules stop <module-id>
          docker-host modules restart <module-id>
          docker-host modules update <module-id>
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
            _ => throw new CommandUsageException($"Unknown modules command '{args[0]}'.", Usage),
        };
    }

    private async Task<int> ListAsync(string[] args)
    {
        if (args.Length != 0)
        {
            throw new CommandUsageException("modules list does not accept arguments.", "Usage: docker-host modules list");
        }

        using var hostApi = await CreateHostApiClientAsync();
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
            context.Console.WriteLine("Install one with docker-host modules install <metadata-url>.");
            return 0;
        }

        var table = new Table()
            .RoundedBorder()
            .AddColumn("Module")
            .AddColumn("Version")
            .AddColumn("Operation")
            .AddColumn("Runtime")
            .AddColumn("Image")
            .AddColumn("Updated")
            .AddColumn("Error");

        foreach (var module in modules)
        {
            table.AddRow(
                Markup.Escape(FormatModuleLabel(module)),
                Markup.Escape(module.Version),
                Markup.Escape(module.OperationStatus),
                Markup.Escape(module.RuntimeStatus?.State ?? "unknown"),
                Markup.Escape(module.Image?.Reference ?? ""),
                Markup.Escape(module.UpdatedAt ?? module.InstalledAt ?? ""),
                Markup.Escape(module.LastError?.Message ?? ""));
        }

        context.Console.Write(table);
        return 0;
    }

    private async Task<int> InstallAsync(string[] args)
    {
        if (args.Length != 1)
        {
            throw new CommandUsageException(
                "modules install requires exactly one metadata URL.",
                "Usage: docker-host modules install <metadata-url>");
        }

        using var hostApi = await CreateHostApiClientAsync();
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
        if (planBody?.Plan is not null)
        {
            RenderInstallPlan(planBody.Plan);
        }

        if (!planResponse.IsSuccess || planBody?.Error is not null)
        {
            return RenderPlanFailure(
                planBody?.Error,
                "Failed to create module install plan.",
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
        if (!Confirm("Apply this module install?"))
        {
            context.Console.MarkupLine("[yellow]Install cancelled.[/]");
            return 130;
        }

        var applyResponse = await hostApi.ApplyInstallAsync(request);
        var applyBody = applyResponse.Body;
        if (!applyResponse.IsSuccess || applyBody?.Error is not null)
        {
            return RenderPlanFailure(
                applyBody?.Error,
                "Failed to install module.",
                applyResponse.StatusCode,
                applyResponse.RawBody);
        }

        context.Console.MarkupLine("[green]Module install completed.[/]");
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

    private async Task<int> RunLifecycleActionAsync(string action, string[] args)
    {
        if (args.Length != 1)
        {
            throw new CommandUsageException(
                $"modules {action} requires exactly one module id.",
                $"Usage: docker-host modules {action} <module-id>");
        }

        using var hostApi = await CreateHostApiClientAsync();
        if (hostApi is null)
        {
            return 1;
        }

        if (!await EnsureHostReadyAsync(hostApi))
        {
            return 1;
        }

        var response = await hostApi.RunModuleActionAsync(args[0], action);
        var body = response.Body;
        if (!response.IsSuccess || body?.Success != true)
        {
            RenderModuleOperationError(body?.Error, $"Failed to {action} module.", response.StatusCode, response.RawBody);
            return response.StatusCode == HttpStatusCode.UnprocessableEntity ? 2 : 1;
        }

        context.Console.MarkupLine($"[green]Module {Markup.Escape(action)} completed.[/]");
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
                "modules update requires exactly one module id.",
                "Usage: docker-host modules update <module-id>");
        }

        using var hostApi = await CreateHostApiClientAsync();
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
                "Failed to create module update plan.",
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
        if (!Confirm("Apply this module update?"))
        {
            context.Console.MarkupLine("[yellow]Update cancelled.[/]");
            return 130;
        }

        var applyResponse = await hostApi.ApplyUpdateAsync(moduleId, request);
        var applyBody = applyResponse.Body;
        if (!applyResponse.IsSuccess || applyBody?.Error is not null)
        {
            return RenderPlanFailure(
                applyBody?.Error,
                "Failed to update module.",
                applyResponse.StatusCode,
                applyResponse.RawBody);
        }

        context.Console.MarkupLine("[green]Module update completed.[/]");
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

    private async Task<HostApiClient?> CreateHostApiClientAsync()
    {
        var settings = context.SettingsStore.Load();
        settings.Validate(context.Environment);

        using var docker = context.DockerFactory.Create(settings.HostDockerEndpoint);
        var container = await docker.InspectContainerAsync(settings.HostContainerName);
        if (container is null)
        {
            context.Console.MarkupLine("[red]Host container does not exist.[/]");
            context.Console.WriteLine("Run docker-host start first.");
            return null;
        }

        if (container.State?.Running != true)
        {
            context.Console.MarkupLine("[red]Host container is not running.[/]");
            context.Console.WriteLine("Run docker-host start first.");
            return null;
        }

        var url = HostLifecycle.TryGetHostUrl(container, settings);
        if (url is null)
        {
            context.Console.MarkupLine("[red]Unable to determine the Host API URL from Docker container metadata.[/]");
            context.Console.WriteLine("Run docker-host status and docker-host start to inspect or recreate the Host container.");
            return null;
        }

        var baseUri = new Uri(url);
        var token = new HostAuthTokenStore(context.Environment).GetTokenForHost(baseUri);
        return context.HostApiFactory.Create(baseUri, token);
    }

    private async Task<bool> EnsureHostReadyAsync(HostApiClient hostApi)
    {
        var response = await hostApi.GetHostStatusAsync();
        if (response.IsSuccess)
        {
            return true;
        }

        context.Console.MarkupLine("[red]Docker Host is not ready.[/]");
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
}
