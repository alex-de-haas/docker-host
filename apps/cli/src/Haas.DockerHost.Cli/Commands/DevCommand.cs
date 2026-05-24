namespace Haas.DockerHost.Cli.Commands;

using System.Diagnostics;
using System.Net;
using Haas.DockerHost.Cli.Configuration;
using Haas.DockerHost.Cli.Docker;
using Haas.DockerHost.Cli.HostApi;
using Spectre.Console;

internal sealed class DevCommand(CommandContext context)
{
    public const string Usage = """
        Usage:
          docker-host dev up [--manifest <path>] [--host-url <url>] [--prepare-only]
          docker-host dev status [--manifest <path>] [--host-url <url>]
          docker-host dev reset [--manifest <path>] [--host-url <url>]

        Default manifest path: .docker-host/dev.json
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
            "up" => await UpAsync(args[1..]),
            "status" => await StatusAsync(args[1..]),
            "reset" => await ResetAsync(args[1..]),
            _ => throw new CommandUsageException($"Unknown dev command '{args[0]}'.", Usage),
        };
    }

    private async Task<int> UpAsync(string[] args)
    {
        var options = ParseOptions(args, allowPrepareOnly: true);
        var manifest = DevManifest.Load(options.ManifestPath);
        var targetId = manifest.GetTargetId();

        if (!options.PrepareOnly && string.IsNullOrWhiteSpace(manifest.ModuleCommand))
        {
            throw new CommandUsageException("dev up requires moduleCommand in the manifest unless --prepare-only is set.", Usage);
        }

        var host = await PrepareHostAsync(manifest, options);
        if (host is null)
        {
            return 1;
        }

        await using (host)
        {
            using var hostApi = CreateHostApiClient(host.Origin);
            if (!await EnsureHostReadyAsync(hostApi))
            {
                return 1;
            }

            var targetResponse = await LinkDevTargetAsync(hostApi, manifest, targetId, host.Mode);

            if (!targetResponse.IsSuccess || targetResponse.Body?.Target is null)
            {
                return RenderApiFailure("Failed to link module developer target.", targetResponse.StatusCode, targetResponse.RawBody);
            }

            var target = targetResponse.Body.Target;
            await SeedUsersAsync(hostApi, manifest, target.ModuleId);
            await ApplyDirectoryPolicyAsync(hostApi, manifest, target.ModuleId);

            RenderUpSummary(host.Origin.ToString().TrimEnd('/'), target, manifest, host.Mode);
            if (options.PrepareOnly)
            {
                return 0;
            }

            return await RunModuleCommandAsync(manifest, host.Origin.ToString().TrimEnd('/'), target, host.Process);
        }
    }

    private async Task<HostApiResponse<ModuleDevTargetResponse>> LinkDevTargetAsync(
        HostApiClient hostApi,
        DevManifest manifest,
        string targetId,
        DevHostMode hostMode)
    {
        var metadataServer = StartMetadataServerIfNeeded(manifest, hostMode);
        try
        {
            var metadataUrl = metadataServer?.PublicUrl ?? manifest.MetadataUrl?.Trim() ?? "";
            return await hostApi.UpdateModuleDevTargetAsync(targetId, new ModuleDevTargetRequest
            {
                Id = targetId,
                MetadataUrl = metadataUrl,
                Hostname = manifest.Target.Hostname,
                PortKey = manifest.Target.PortKey,
                TargetBaseUrl = manifest.GetTargetBaseUrl(hostMode),
                ExposurePolicy = manifest.Target.Policy,
                IdentityMode = manifest.Target.Identity,
                Enabled = true,
            });
        }
        finally
        {
            if (metadataServer is not null)
            {
                await metadataServer.DisposeAsync();
            }
        }
    }

    private async Task<int> StatusAsync(string[] args)
    {
        var options = ParseOptions(args, allowPrepareOnly: false);
        var manifest = DevManifest.Load(options.ManifestPath);
        var targetId = manifest.GetTargetId();
        var host = await ResolveRunningHostAsync(manifest, options);
        if (host is null)
        {
            return 1;
        }

        using var hostApi = CreateHostApiClient(host.Origin);
        var hostReady = await IsHostReadyAsync(hostApi);
        if (!hostReady)
        {
            var hostTable = new Table()
                .RoundedBorder()
                .AddColumn("Check")
                .AddColumn("Status")
                .AddColumn("Detail");
            hostTable.AddRow("Host mode", "[green]configured[/]", Markup.Escape(FormatHostMode(host.Mode)));
            hostTable.AddRow("Host origin", "[green]configured[/]", Markup.Escape(host.Origin.ToString().TrimEnd('/')));
            hostTable.AddRow("Host API", "[red]not ready[/]", "");
            context.Console.Write(hostTable);
            return 1;
        }

        var targetsResponse = await hostApi.ListModuleDevTargetsAsync();
        if (!targetsResponse.IsSuccess || targetsResponse.Body is null)
        {
            return RenderApiFailure("Failed to read module developer targets.", targetsResponse.StatusCode, targetsResponse.RawBody);
        }

        var target = targetsResponse.Body.Targets.FirstOrDefault(candidate => candidate.Id == targetId);
        var targetBaseUrl = manifest.GetTargetBaseUrl(host.Mode);
        var targetReachable = await ProbeTargetAsync(targetBaseUrl);
        HostAppSummary? app = null;
        var appsResponse = await hostApi.ListAppsAsync();
        if (appsResponse.IsSuccess && appsResponse.Body is not null)
        {
            app = appsResponse.Body.Apps.FirstOrDefault(candidate => candidate.DeveloperTargetId == targetId);
        }

        var table = new Table()
            .RoundedBorder()
            .AddColumn("Check")
            .AddColumn("Status")
            .AddColumn("Detail");

        table.AddRow("Host mode", "[green]configured[/]", Markup.Escape(FormatHostMode(host.Mode)));
        table.AddRow("Host origin", "[green]configured[/]", Markup.Escape(host.Origin.ToString().TrimEnd('/')));
        table.AddRow("Host API", hostReady ? "[green]ready[/]" : "[red]not ready[/]", "");
        table.AddRow(
            "Developer mode",
            targetsResponse.Body.DeveloperModeEnabled ? "[green]enabled[/]" : "[red]disabled[/]",
            targetsResponse.Body.DeveloperModeEnabled ? "" : "Run docker-host dev up to enable and restart the Host.");
        table.AddRow(
            "Developer target",
            target is not null ? "[green]linked[/]" : "[yellow]missing[/]",
            target is null ? targetId : $"{Markup.Escape(target.ModuleName)} ({Markup.Escape(target.ModuleId)})");
        table.AddRow(
            "Target URL",
            targetReachable ? "[green]reachable[/]" : "[red]unreachable[/]",
            Markup.Escape(targetBaseUrl));
        table.AddRow(
            "App registry",
            app is not null ? "[green]visible[/]" : "[yellow]not visible[/]",
            app?.DisplayName is null ? "" : Markup.Escape(app.DisplayName));
        table.AddRow(
            "Identity mode",
            target is null ? "[yellow]unknown[/]" : Markup.Escape(target.IdentityMode),
            target?.ExposurePolicy is null ? "" : Markup.Escape(target.ExposurePolicy));

        context.Console.Write(table);
        return hostReady && targetsResponse.Body.DeveloperModeEnabled && target is not null && targetReachable ? 0 : 1;
    }

    private async Task<int> ResetAsync(string[] args)
    {
        var options = ParseOptions(args, allowPrepareOnly: false);
        var manifest = DevManifest.Load(options.ManifestPath);
        var targetId = manifest.GetTargetId();
        var host = await ResolveRunningHostAsync(manifest, options);
        if (host is null)
        {
            return 1;
        }

        using var hostApi = CreateHostApiClient(host.Origin);
        var targetsResponse = await hostApi.ListModuleDevTargetsAsync();
        if (!targetsResponse.IsSuccess || targetsResponse.Body is null)
        {
            return RenderApiFailure("Failed to read module developer targets.", targetsResponse.StatusCode, targetsResponse.RawBody);
        }

        var existingTarget = targetsResponse.Body.Targets.FirstOrDefault(candidate => candidate.Id == targetId);
        var moduleId = existingTarget?.ModuleId;
        if (existingTarget is not null)
        {
            var deleteResponse = await hostApi.DeleteModuleDevTargetAsync(targetId);
            if (!deleteResponse.IsSuccess)
            {
                return RenderApiFailure("Failed to delete module developer target.", deleteResponse.StatusCode, deleteResponse.RawBody);
            }

            context.Console.MarkupLine($"[green]Developer target removed:[/] {Markup.Escape(targetId)}");
        }
        else
        {
            context.Console.MarkupLine($"[yellow]Developer target was not linked:[/] {Markup.Escape(targetId)}");
        }

        if (!string.IsNullOrWhiteSpace(moduleId))
        {
            await RemoveManifestAssignmentsAsync(hostApi, manifest, moduleId);
            if (manifest.DirectoryPolicy is not null)
            {
                var policyResponse = await hostApi.SetModuleDirectoryPolicyAsync(
                    moduleId,
                    new ModuleDirectoryPolicyRequest { IncludeEmail = false });
                if (!policyResponse.IsSuccess)
                {
                    return RenderApiFailure("Failed to reset module directory policy.", policyResponse.StatusCode, policyResponse.RawBody);
                }

                context.Console.MarkupLine("[green]Module directory policy reset.[/]");
            }
        }
        else
        {
            context.Console.MarkupLine("[yellow]Skipped user assignment and directory policy reset because the module id is unknown.[/]");
        }

        return 0;
    }

    private async Task<DevHostSession?> PrepareHostAsync(DevManifest manifest, DevCommandOptions options)
    {
        var mode = GetEffectiveHostMode(manifest, options);
        if (mode == DevHostMode.DockerContainer)
        {
            var settings = await EnsureDevModeConfiguredAsync();
            var container = await new HostLifecycle(context).StartAsync(settings.SettingsForStart, recreate: settings.RestartRequired);
            if (container is null)
            {
                return null;
            }

            var hostUrl = HostLifecycle.TryGetHostUrl(container, settings.SettingsForStart)
                ?? throw new ConfigurationException("Unable to determine the Host URL after start.");
            return new DevHostSession(new Uri(hostUrl), mode);
        }

        var origin = GetConfiguredHostOrigin(manifest, options, mode);
        if (mode == DevHostMode.External)
        {
            context.Console.MarkupLine($"[green]Using external Host:[/] {Markup.Escape(origin.ToString().TrimEnd('/'))}");
            return new DevHostSession(origin, mode);
        }

        if (string.IsNullOrWhiteSpace(manifest.Host.Command))
        {
            throw new CommandUsageException(
                "dev up requires host.command when host.mode is local-process. Use host.mode external with host.origin when the Host is already running.",
                Usage);
        }

        var process = StartHostProcess(manifest, origin);
        using var hostApi = CreateHostApiClient(origin);
        var ready = await WaitForLocalHostReadyAsync(hostApi, process);
        if (!ready)
        {
            KillProcessTree(process);
            process.Dispose();
            return null;
        }

        return new DevHostSession(origin, mode, process);
    }

    private async Task<DevHostSession?> ResolveRunningHostAsync(DevManifest manifest, DevCommandOptions options)
    {
        var mode = GetEffectiveHostMode(manifest, options);
        if (mode != DevHostMode.DockerContainer)
        {
            return new DevHostSession(GetConfiguredHostOrigin(manifest, options, mode), mode);
        }

        var settings = context.SettingsStore.Load();
        settings.Validate(context.Environment);

        using var docker = context.DockerFactory.Create(settings.HostDockerEndpoint);
        await docker.EnsureLinuxEngineAsync();
        var container = await docker.InspectContainerAsync(settings.HostContainerName);
        if (container is null)
        {
            context.Console.MarkupLine("[red]Host container does not exist.[/]");
            return null;
        }

        if (container.State?.Running != true)
        {
            context.Console.MarkupLine("[red]Host container is not running.[/]");
            context.Console.WriteLine("Run docker-host dev up first, or start Docker Host before running this command.");
            return null;
        }

        var hostUrl = HostLifecycle.TryGetHostUrl(container, settings)
            ?? throw new ConfigurationException("Unable to determine the Host API URL from Docker container metadata.");
        return new DevHostSession(new Uri(hostUrl), mode);
    }

    private static DevHostMode GetEffectiveHostMode(DevManifest manifest, DevCommandOptions options)
        => options.HostOrigin is null ? manifest.GetHostMode() : DevHostMode.External;

    private static Uri GetConfiguredHostOrigin(DevManifest manifest, DevCommandOptions options, DevHostMode mode)
    {
        if (options.HostOrigin is not null)
        {
            return options.HostOrigin;
        }

        return manifest.GetHostOrigin(mode)
            ?? throw new CommandUsageException(
                "A Host origin is required. Set host.origin, host.port, or pass --host-url <url>.",
                Usage);
    }

    private Process StartHostProcess(DevManifest manifest, Uri origin)
    {
        var workingDirectory = manifest.ResolveHostWorkingDirectory() ?? manifest.ManifestDirectory;
        var startInfo = CreateShellStartInfo(manifest.Host.Command!, workingDirectory);
        foreach (var (key, value) in BuildHostEnvironment(manifest, origin))
        {
            startInfo.Environment[key] = value;
        }

        context.Console.MarkupLine($"[green]Starting Host command:[/] {Markup.Escape(manifest.Host.Command!)}");
        context.Console.MarkupLine($"[grey]Host origin:[/] {Markup.Escape(origin.ToString().TrimEnd('/'))}");
        context.Console.MarkupLine($"[grey]Host working directory:[/] {Markup.Escape(workingDirectory)}");

        try
        {
            return Process.Start(startInfo)
                ?? throw new ConfigurationException("Unable to start Host command.");
        }
        catch (Exception ex) when (ex is not ConfigurationException)
        {
            throw new ConfigurationException($"Unable to start Host command: {ex.Message}");
        }
    }

    private IReadOnlyDictionary<string, string> BuildHostEnvironment(DevManifest manifest, Uri origin)
    {
        var values = new Dictionary<string, string>(manifest.Host.Environment, StringComparer.Ordinal)
        {
            ["HOST_MODULE_DEV_MODE"] = "enabled",
            ["HOST_INTERNAL_ORIGIN"] = origin.ToString().TrimEnd('/'),
        };

        if (!values.ContainsKey("PORT") && origin.Port > 0 && !origin.IsDefaultPort)
        {
            values["PORT"] = origin.Port.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        return values;
    }

    private async Task<bool> WaitForLocalHostReadyAsync(HostApiClient hostApi, Process process)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(60);
        HostApiException? lastError = null;
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (process.HasExited)
            {
                context.Console.MarkupLine($"[red]Local Host command exited before the Host API became ready.[/] Exit code: {process.ExitCode}");
                return false;
            }

            try
            {
                var response = await hostApi.GetHostStatusAsync();
                if (response.IsSuccess)
                {
                    return true;
                }

                if ((int)response.StatusCode < 500)
                {
                    RenderApiFailure("Docker Host is reachable but not ready for CLI dev operations.", response.StatusCode, response.RawBody);
                    return false;
                }
            }
            catch (HostApiException ex)
            {
                lastError = ex;
            }

            await Task.Delay(500);
        }

        context.Console.MarkupLine("[red]Timed out waiting for the local Host API.[/]");
        if (lastError is not null && !string.IsNullOrWhiteSpace(lastError.ResponseBody))
        {
            context.Console.MarkupLine($"[grey]Last error:[/] {Markup.Escape(lastError.ResponseBody)}");
        }

        return false;
    }

    private async Task<(LaunchSettings SettingsForStart, bool RestartRequired)> EnsureDevModeConfiguredAsync()
    {
        var settings = context.SettingsStore.EnsureInstalled();
        var restartRequired = false;
        if (!string.Equals(settings.HostModuleDevMode, "enabled", StringComparison.Ordinal))
        {
            settings = settings.WithValue(LaunchSettingDefinitions.HostModuleDevMode, "enabled");
            context.SettingsStore.Save(settings);
            restartRequired = true;
            context.Console.MarkupLine("[green]Enabled HOST_MODULE_DEV_MODE.[/]");
        }

        var settingsForStart = restartRequired
            ? await PreserveCurrentAutoPortForRestartAsync(settings)
            : settings;

        return (settingsForStart, restartRequired);
    }

    private async Task<LaunchSettings> PreserveCurrentAutoPortForRestartAsync(LaunchSettings settings)
    {
        if (!string.Equals(settings.HostUiPort, "auto", StringComparison.OrdinalIgnoreCase))
        {
            return settings;
        }

        using var docker = context.DockerFactory.Create(settings.HostDockerEndpoint);
        var existing = await docker.InspectContainerAsync(settings.HostContainerName);
        var currentPort = HostLifecycle.TryGetMappedPort(existing);
        return currentPort is null
            ? settings
            : settings.WithValue(LaunchSettingDefinitions.HostUiPort, currentPort.Value.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    private HostApiClient CreateHostApiClient(Uri hostOrigin)
    {
        var tokenStore = new HostAuthTokenStore(context.Environment);
        var token = tokenStore.GetTokenForHost(hostOrigin);
        return context.HostApiFactory.Create(hostOrigin, token);
    }

    private async Task<bool> EnsureHostReadyAsync(HostApiClient hostApi)
    {
        try
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
        }
        catch (HostApiException ex)
        {
            context.Console.MarkupLine("[red]Docker Host is not reachable.[/]");
            if (!string.IsNullOrWhiteSpace(ex.ResponseBody))
            {
                context.Console.WriteLine(ex.ResponseBody);
            }
        }

        return false;
    }

    private static async Task<bool> IsHostReadyAsync(HostApiClient hostApi)
    {
        try
        {
            return (await hostApi.GetHostStatusAsync()).IsSuccess;
        }
        catch (HostApiException)
        {
            return false;
        }
    }

    private async Task SeedUsersAsync(HostApiClient hostApi, DevManifest manifest, string moduleId)
    {
        if (manifest.Users.Count == 0)
        {
            return;
        }

        var usersResponse = await hostApi.ListHostUsersAsync();
        if (!usersResponse.IsSuccess || usersResponse.Body is null)
        {
            throw new HostApiException("list Host users", "Unable to read Host users.", usersResponse.StatusCode, usersResponse.RawBody);
        }

        var users = usersResponse.Body.Users.ToList();
        var pendingInvitations = usersResponse.Body.Invitations
            .Where(invitation => string.Equals(invitation.Status, "pending", StringComparison.Ordinal))
            .ToList();

        foreach (var manifestUser in manifest.Users)
        {
            var email = manifestUser.Email.Trim();
            var user = users.FirstOrDefault(candidate =>
                !candidate.Disabled &&
                string.Equals(candidate.Email, email, StringComparison.OrdinalIgnoreCase));

            if (user is null)
            {
                var pendingInvitation = pendingInvitations.FirstOrDefault(candidate =>
                    string.Equals(candidate.Email, email, StringComparison.OrdinalIgnoreCase));
                if (pendingInvitation is not null)
                {
                    await RevokeExistingInvitationAsync(hostApi, pendingInvitation);
                    pendingInvitations.Remove(pendingInvitation);
                }

                user = await CreateDevUserAsync(hostApi, manifest, manifestUser, moduleId);
                users.Add(user);
                context.Console.MarkupLine($"[green]Created development user:[/] {Markup.Escape(manifestUser.Email)}");
            }
            else
            {
                user = await UpdateExistingDevUserAsync(hostApi, manifestUser, user);
                context.Console.MarkupLine($"[grey]Using existing development user:[/] {Markup.Escape(manifestUser.Email)}");
            }

            var assignedModuleIds = user.AssignedModuleIds.ToHashSet(StringComparer.Ordinal);
            var changed = manifestUser.Assigned
                ? assignedModuleIds.Add(moduleId)
                : assignedModuleIds.Remove(moduleId);
            if (changed)
            {
                var response = await hostApi.ReplaceHostUserAssignmentsAsync(user.Id, new HostUserAssignmentsRequest
                {
                    AssignedModuleIds = assignedModuleIds.OrderBy(candidate => candidate, StringComparer.Ordinal).ToArray(),
                });
                if (!response.IsSuccess)
                {
                    throw new HostApiException("replace Host user module assignments", "Unable to seed development assignments.", response.StatusCode, response.RawBody);
                }
            }
        }
    }

    private async Task RevokeExistingInvitationAsync(HostApiClient hostApi, UserInvitationSummary invitation)
    {
        var response = await hostApi.RevokeUserInvitationAsync(invitation.Id);
        if (!response.IsSuccess)
        {
            throw new HostApiException(
                "revoke Host user invitation",
                "Unable to revoke an existing development user invitation.",
                response.StatusCode,
                response.RawBody);
        }

        context.Console.MarkupLine($"[grey]Revoked existing development invitation:[/] {Markup.Escape(invitation.Email)}");
    }

    private async Task<HostUserSummary> CreateDevUserAsync(
        HostApiClient hostApi,
        DevManifest manifest,
        DevManifestUser manifestUser,
        string moduleId)
    {
        var createResponse = await hostApi.CreateUserInvitationAsync(new UserInvitationCreateRequest
        {
            Email = manifestUser.Email.Trim(),
            DisplayName = manifestUser.DisplayName,
            Role = manifestUser.Role,
            AssignedModuleIds = manifestUser.Assigned ? [moduleId] : [],
        });
        if (!createResponse.IsSuccess || string.IsNullOrWhiteSpace(createResponse.Body?.Token))
        {
            throw new HostApiException("create Host user invitation", "Unable to create development user invitation.", createResponse.StatusCode, createResponse.RawBody);
        }

        var acceptResponse = await hostApi.AcceptUserInvitationAsync(new UserInvitationAcceptRequest
        {
            SetupToken = createResponse.Body.Token,
            Email = manifestUser.Email.Trim(),
            DisplayName = manifestUser.DisplayName,
            Password = manifest.GetPassword(manifestUser),
        });
        if (!acceptResponse.IsSuccess || acceptResponse.Body?.User is null)
        {
            throw new HostApiException("accept Host user invitation", "Unable to accept development user invitation.", acceptResponse.StatusCode, acceptResponse.RawBody);
        }

        return acceptResponse.Body.User;
    }

    private async Task<HostUserSummary> UpdateExistingDevUserAsync(
        HostApiClient hostApi,
        DevManifestUser manifestUser,
        HostUserSummary user)
    {
        var desiredDisplayName = manifestUser.DisplayName ?? user.DisplayName;
        if (string.Equals(user.Role, manifestUser.Role, StringComparison.Ordinal) &&
            string.Equals(user.DisplayName, desiredDisplayName, StringComparison.Ordinal))
        {
            return user;
        }

        var response = await hostApi.UpdateHostUserAsync(user.Id, new HostUserUpdateRequest
        {
            DisplayName = desiredDisplayName,
            Role = manifestUser.Role,
        });
        if (!response.IsSuccess || response.Body?.User is null)
        {
            throw new HostApiException("update Host user", "Unable to update development user.", response.StatusCode, response.RawBody);
        }

        return response.Body.User;
    }

    private async Task RemoveManifestAssignmentsAsync(HostApiClient hostApi, DevManifest manifest, string moduleId)
    {
        if (manifest.Users.Count == 0)
        {
            return;
        }

        var usersResponse = await hostApi.ListHostUsersAsync();
        if (!usersResponse.IsSuccess || usersResponse.Body is null)
        {
            throw new HostApiException("list Host users", "Unable to read Host users.", usersResponse.StatusCode, usersResponse.RawBody);
        }

        foreach (var manifestUser in manifest.Users)
        {
            var user = usersResponse.Body.Users.FirstOrDefault(candidate =>
                !candidate.Disabled &&
                string.Equals(candidate.Email, manifestUser.Email.Trim(), StringComparison.OrdinalIgnoreCase));
            if (user is null || !user.AssignedModuleIds.Contains(moduleId, StringComparer.Ordinal))
            {
                continue;
            }

            var assignedModuleIds = user.AssignedModuleIds
                .Where(candidate => !string.Equals(candidate, moduleId, StringComparison.Ordinal))
                .OrderBy(candidate => candidate, StringComparer.Ordinal)
                .ToArray();
            var response = await hostApi.ReplaceHostUserAssignmentsAsync(user.Id, new HostUserAssignmentsRequest
            {
                AssignedModuleIds = assignedModuleIds,
            });
            if (!response.IsSuccess)
            {
                throw new HostApiException("replace Host user module assignments", "Unable to reset development assignments.", response.StatusCode, response.RawBody);
            }
        }

        context.Console.MarkupLine("[green]Manifest user assignments reset.[/]");
    }

    private async Task ApplyDirectoryPolicyAsync(HostApiClient hostApi, DevManifest manifest, string moduleId)
    {
        if (manifest.DirectoryPolicy is null)
        {
            return;
        }

        var response = await hostApi.SetModuleDirectoryPolicyAsync(moduleId, new ModuleDirectoryPolicyRequest
        {
            IncludeEmail = manifest.DirectoryPolicy.IncludeEmail,
        });
        if (!response.IsSuccess)
        {
            throw new HostApiException("set module directory policy", "Unable to seed module directory policy.", response.StatusCode, response.RawBody);
        }
    }

    private async Task<int> RunModuleCommandAsync(
        DevManifest manifest,
        string hostUrl,
        ModuleDevTargetSummary target,
        Process? ownedHostProcess)
    {
        var startInfo = CreateShellStartInfo(manifest.ModuleCommand!, manifest.ResolveWorkingDirectory());
        foreach (var (key, value) in BuildModuleEnvironment(manifest, hostUrl, target))
        {
            startInfo.Environment[key] = value;
        }

        context.Console.MarkupLine($"[green]Starting module command:[/] {Markup.Escape(manifest.ModuleCommand!)}");
        context.Console.MarkupLine($"[grey]Working directory:[/] {Markup.Escape(startInfo.WorkingDirectory)}");

        Process? process;
        try
        {
            process = Process.Start(startInfo);
        }
        catch (Exception ex)
        {
            context.Console.MarkupLine($"[red]Unable to start module command:[/] {Markup.Escape(ex.Message)}");
            return 1;
        }

        if (process is null)
        {
            context.Console.MarkupLine("[red]Unable to start module command.[/]");
            return 1;
        }

        using (process)
        {
            ConsoleCancelEventHandler? handler = null;
            handler = (_, eventArgs) =>
            {
                eventArgs.Cancel = true;
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }

                KillProcessTree(ownedHostProcess);
            };

            Console.CancelKeyPress += handler;
            try
            {
                var moduleExit = process.WaitForExitAsync();
                var hostExit = ownedHostProcess is null
                    ? Task.Delay(Timeout.InfiniteTimeSpan)
                    : ownedHostProcess.WaitForExitAsync();
                var completed = await Task.WhenAny(moduleExit, hostExit);
                if (completed == hostExit && ownedHostProcess is not null)
                {
                    context.Console.MarkupLine($"[red]Local Host command exited.[/] Exit code: {ownedHostProcess.ExitCode}");
                    KillProcessTree(process);
                    await moduleExit;
                    return ownedHostProcess.ExitCode == 0 ? 1 : ownedHostProcess.ExitCode;
                }

                KillProcessTree(ownedHostProcess);
                return process.ExitCode;
            }
            finally
            {
                Console.CancelKeyPress -= handler;
            }
        }
    }

    private ProcessStartInfo CreateShellStartInfo(string command, string workingDirectory)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = context.Environment.IsWindows ? "cmd.exe" : "/bin/sh",
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
        };

        if (context.Environment.IsWindows)
        {
            startInfo.ArgumentList.Add("/c");
            startInfo.ArgumentList.Add(command);
        }
        else
        {
            startInfo.ArgumentList.Add("-lc");
            startInfo.ArgumentList.Add(command);
        }

        return startInfo;
    }

    private IReadOnlyDictionary<string, string> BuildModuleEnvironment(
        DevManifest manifest,
        string hostUrl,
        ModuleDevTargetSummary target)
    {
        var values = new Dictionary<string, string>(manifest.Environment, StringComparer.Ordinal)
        {
            ["DOCKER_HOST_INTERNAL_ORIGIN"] = hostUrl,
            ["DOCKER_HOST_MODULE_ID"] = target.ModuleId,
            ["MODULE_ID"] = target.ModuleId,
            ["MODULE_VERSION"] = target.ModuleVersion,
        };

        return values;
    }

    private void RenderUpSummary(string hostUrl, ModuleDevTargetSummary target, DevManifest manifest, DevHostMode hostMode)
    {
        context.Console.MarkupLine("[green]Dev harness prepared.[/]");
        context.Console.MarkupLine($"Host mode: [grey]{Markup.Escape(FormatHostMode(hostMode))}[/]");
        context.Console.MarkupLine($"Host shell app: [link]{Markup.Escape($"{hostUrl.TrimEnd('/')}/apps/dev/{Uri.EscapeDataString(target.Id)}")}[/]");
        context.Console.MarkupLine($"Gateway URL: [link]{Markup.Escape(BuildGatewayUrl(hostUrl, target.Hostname))}[/]");
        if (manifest.Users.Count > 0)
        {
            context.Console.MarkupLine("Development accounts:");
            foreach (var user in manifest.Users)
            {
                context.Console.MarkupLine($"  {Markup.Escape(user.Email)} ({Markup.Escape(user.Role)}) password: [grey]{Markup.Escape(manifest.GetPassword(user))}[/]");
            }
        }
    }

    private static string BuildGatewayUrl(string hostUrl, string hostname)
    {
        var uri = new Uri(hostUrl);
        var builder = new UriBuilder(uri)
        {
            Host = hostname,
            Path = "",
            Query = "",
            Fragment = "",
        };
        return builder.Uri.GetLeftPart(UriPartial.Authority);
    }

    private static string FormatHostMode(DevHostMode mode)
        => mode switch
        {
            DevHostMode.DockerContainer => "docker-container",
            DevHostMode.LocalProcess => "local-process",
            DevHostMode.External => "external",
            _ => mode.ToString(),
        };

    private static void KillProcessTree(Process? process)
    {
        if (process is null || process.HasExited)
        {
            return;
        }

        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch
        {
        }
    }

    private async Task<bool> ProbeTargetAsync(string targetBaseUrl)
    {
        using var http = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(5),
        };

        try
        {
            using var response = await http.GetAsync(BuildTargetProbeUrl(targetBaseUrl));
            return response.StatusCode != HttpStatusCode.NotFound &&
                (int)response.StatusCode < 500;
        }
        catch
        {
            return false;
        }
    }

    internal static string BuildTargetProbeUrl(string targetBaseUrl)
    {
        if (!Uri.TryCreate(targetBaseUrl, UriKind.Absolute, out var uri) ||
            !string.Equals(uri.Host, "host.docker.internal", StringComparison.OrdinalIgnoreCase))
        {
            return targetBaseUrl;
        }

        var builder = new UriBuilder(uri)
        {
            Host = IPAddress.Loopback.ToString(),
        };
        return builder.Uri.ToString();
    }

    private LocalMetadataFileServer? StartMetadataServerIfNeeded(DevManifest manifest, DevHostMode hostMode)
    {
        if (!string.IsNullOrWhiteSpace(manifest.MetadataUrl))
        {
            return null;
        }

        var metadataFile = manifest.ResolveMetadataFile()
            ?? throw new CommandUsageException("Dev manifest metadataFile is required when metadataUrl is not set.", Usage);
        var metadataFileHost = manifest.MetadataFileHost ??
            (hostMode == DevHostMode.DockerContainer ? "host.docker.internal" : IPAddress.Loopback.ToString());
        var server = LocalMetadataFileServer.Start(
            metadataFile,
            metadataFileHost,
            ex => context.Console.MarkupLine($"[yellow]Metadata file server warning:[/] {Markup.Escape(ex.Message)}"));
        context.Console.MarkupLine($"[grey]Serving metadata file for Host fetch:[/] {Markup.Escape(server.PublicUrl)}");
        return server;
    }

    private static DevCommandOptions ParseOptions(string[] args, bool allowPrepareOnly)
    {
        var manifestPath = Path.Combine(Directory.GetCurrentDirectory(), ".docker-host", "dev.json");
        var prepareOnly = false;
        Uri? hostOrigin = null;

        for (var index = 0; index < args.Length; index++)
        {
            var arg = args[index];
            switch (arg)
            {
                case "--manifest":
                case "-m":
                    if (index + 1 >= args.Length)
                    {
                        throw new CommandUsageException($"{arg} requires a path.", Usage);
                    }

                    manifestPath = args[++index];
                    break;
                case "--host-url":
                case "--host-origin":
                    if (index + 1 >= args.Length)
                    {
                        throw new CommandUsageException($"{arg} requires a URL.", Usage);
                    }

                    hostOrigin = ParseHostOriginOverride(args[++index]);
                    break;
                case "--prepare-only":
                    if (!allowPrepareOnly)
                    {
                        throw new CommandUsageException("--prepare-only is only supported by dev up.", Usage);
                    }

                    prepareOnly = true;
                    break;
                default:
                    throw new CommandUsageException($"Unknown dev option '{arg}'.", Usage);
            }
        }

        return new DevCommandOptions(Path.GetFullPath(manifestPath), prepareOnly, hostOrigin);
    }

    private static Uri ParseHostOriginOverride(string value)
    {
        if (!Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            throw new CommandUsageException("--host-url must be an absolute HTTP(S) URL.", Usage);
        }

        return new Uri(uri.GetLeftPart(UriPartial.Authority));
    }

    private int RenderApiFailure(string message, HttpStatusCode statusCode, string rawBody)
    {
        context.Console.MarkupLine($"[red]{Markup.Escape(message)}[/]");
        context.Console.MarkupLine($"[grey]HTTP status:[/] {(int)statusCode} {statusCode}");
        if (!string.IsNullOrWhiteSpace(rawBody))
        {
            context.Console.WriteLine(rawBody);
        }

        return 1;
    }
}

internal sealed record DevCommandOptions(string ManifestPath, bool PrepareOnly, Uri? HostOrigin);

internal sealed class DevHostSession(Uri origin, DevHostMode mode, Process? process = null) : IAsyncDisposable
{
    public Uri Origin { get; } = origin;

    public DevHostMode Mode { get; } = mode;

    public Process? Process { get; } = process;

    public ValueTask DisposeAsync()
    {
        if (Process is null)
        {
            return ValueTask.CompletedTask;
        }

        try
        {
            if (!Process.HasExited)
            {
                Process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
        }
        finally
        {
            Process.Dispose();
        }

        return ValueTask.CompletedTask;
    }
}
