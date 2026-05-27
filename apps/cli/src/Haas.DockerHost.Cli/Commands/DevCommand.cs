namespace Haas.DockerHost.Cli.Commands;

using System.Diagnostics;
using System.Net;
using System.Text.Json;
using Haas.DockerHost.Cli.Configuration;
using Haas.DockerHost.Cli.HostApi;
using Spectre.Console;

internal sealed class DevCommand(CommandContext context)
{
    private const string DefaultHostDevCommand = "npm run host:dev";

    public const string Usage = """
        Usage:
          docker-host dev up [--manifest <path>] [--host-url <url>] [--prepare-only]
          docker-host dev status [--manifest <path>] [--host-url <url>]
          docker-host dev reset [--manifest <path>] [--host-url <url>]
          docker-host dev clean <module-id-or-dev-metadata> [--host-url <url>] [--yes]

        Default metadata path: metadata.dev.json
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
            "clean" => await CleanAsync(args[1..]),
            _ => throw new CommandUsageException($"Unknown dev command '{args[0]}'.", Usage),
        };
    }

    private async Task<int> UpAsync(string[] args)
    {
        var options = ParseOptions(args, allowPrepareOnly: true);
        var host = await PrepareHostAsync(options);
        if (host is null)
        {
            return 1;
        }

        await using (host)
        {
            using var hostApi = CreateHostControlClient(host.Origin);
            if (!await EnsureHostReadyAsync(hostApi))
            {
                return 1;
            }

            var manifest = DevManifest.Load(options.ManifestPath);
            var targetId = manifest.GetTargetId();

            if (!options.PrepareOnly && string.IsNullOrWhiteSpace(manifest.ModuleCommand))
            {
                throw new CommandUsageException("dev up requires metadata.dev.json to define a process service unless --prepare-only is set.", Usage);
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
        HostControlClient hostApi,
        DevManifest manifest,
        string targetId,
        DevHostMode hostMode)
    {
        await using var metadataServer = StartMetadataServer(manifest);
        return await hostApi.UpdateModuleDevTargetAsync(targetId, new ModuleDevTargetRequest
        {
            Id = targetId,
            MetadataUrl = metadataServer.PublicUrl,
            Hostname = manifest.Target.Hostname,
            PortKey = manifest.Target.PortKey,
            TargetBaseUrl = manifest.GetTargetBaseUrl(),
            ExposurePolicy = manifest.Target.Policy,
            IdentityMode = manifest.Target.Identity,
            Enabled = true,
        });
    }

    private async Task<int> StatusAsync(string[] args)
    {
        var options = ParseOptions(args, allowPrepareOnly: false);
        var host = ResolveRunningHost(options);
        if (host is null)
        {
            return 1;
        }

        var manifest = DevManifest.Load(options.ManifestPath);
        var targetId = manifest.GetTargetId();

        using var hostApi = CreateHostControlClient(host.Origin);
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
            hostTable.AddRow("Host control", "[red]not ready[/]", "");
            context.Console.Write(hostTable);
            return 1;
        }

        var targetsResponse = await hostApi.ListModuleDevTargetsAsync();
        if (!targetsResponse.IsSuccess || targetsResponse.Body is null)
        {
            return RenderApiFailure("Failed to read module developer targets.", targetsResponse.StatusCode, targetsResponse.RawBody);
        }

        var target = targetsResponse.Body.Targets.FirstOrDefault(candidate => candidate.Id == targetId);
        var targetBaseUrl = manifest.GetTargetBaseUrl();
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
        table.AddRow("Host control", hostReady ? "[green]ready[/]" : "[red]not ready[/]", "");
        table.AddRow(
            "Developer targets",
            targetsResponse.Body.DeveloperModeEnabled ? "[green]available[/]" : "[red]unavailable[/]",
            targetsResponse.Body.DeveloperModeEnabled ? "" : "Check Host local control discovery.");
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
        var host = ResolveRunningHost(options);
        if (host is null)
        {
            return 1;
        }

        var manifest = DevManifest.Load(options.ManifestPath);
        var targetId = manifest.GetTargetId();

        using var hostApi = CreateHostControlClient(host.Origin);
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

    private async Task<int> CleanAsync(string[] args)
    {
        var options = ParseCleanOptions(args);
        var host = ResolveRunningHost(options.HostOrigin);
        if (host is null)
        {
            return 1;
        }

        await using (host)
        {
            var moduleId = ResolveDevCleanModuleId(options.Target);
            if (!options.AssumeYes && !context.Console.Prompt(new ConfirmationPrompt($"Delete stored development data for {moduleId}?") { DefaultValue = false }))
            {
                context.Console.MarkupLine("[yellow]Clean cancelled.[/]");
                return 130;
            }

            using var hostApi = CreateHostControlClient(host.Origin);
            var response = await hostApi.CleanDevModuleDataAsync(moduleId);
            if (!response.IsSuccess || response.Body?.Removed != true)
            {
                return RenderApiFailure("Failed to clean development module data.", response.StatusCode, response.RawBody);
            }

            context.Console.MarkupLine($"[green]Development data removed:[/] {Markup.Escape(response.Body.Path)}");
            return 0;
        }
    }

    private async Task<DevHostSession?> PrepareHostAsync(DevCommandOptions options)
    {
        var settings = context.SettingsStore.Load();
        settings.Validate(context.Environment);
        if (options.HostOrigin is not null)
        {
            context.Console.MarkupLine($"[green]Using external Host:[/] {Markup.Escape(options.HostOrigin.ToString().TrimEnd('/'))}");
            return new DevHostSession(options.HostOrigin, DevHostMode.External);
        }

        var repository = RequireHostDevRepository(settings);
        var origin = BuildLoopbackOrigin(settings.GetHostDevPort());
        Directory.CreateDirectory(settings.ResolveHostDataRoot(context.Environment));
        var process = StartHostProcess(repository, origin, settings);
        var ready = await WaitForLocalHostReadyAsync(origin, process);
        if (!ready)
        {
            context.Console.MarkupLine("[yellow]The local Host process was started, but the CLI could not confirm trusted control readiness.[/]");
            context.Console.MarkupLine($"[yellow]The Host may still be running at {Markup.Escape(origin.ToString().TrimEnd('/'))}.[/]");
            context.Console.WriteLine("Restart the Host process so it can publish run/control.json, then retry.");

            process.Dispose();
            return null;
        }

        return new DevHostSession(origin, DevHostMode.LocalProcess, process);
    }

    private DevHostSession? ResolveRunningHost(DevCommandOptions options)
        => ResolveRunningHost(options.HostOrigin);

    private DevHostSession? ResolveRunningHost(Uri? hostOrigin)
    {
        var settings = context.SettingsStore.Load();
        settings.Validate(context.Environment);
        if (hostOrigin is not null)
        {
            return new DevHostSession(hostOrigin, DevHostMode.External);
        }

        _ = RequireHostDevRepository(settings);
        return new DevHostSession(BuildLoopbackOrigin(settings.GetHostDevPort()), DevHostMode.LocalProcess);
    }

    private string RequireHostDevRepository(LaunchSettings settings)
    {
        var configuredRepository = settings.ResolveHostDevRepositoryPath(context.Environment);
        if (string.IsNullOrWhiteSpace(configuredRepository))
        {
            throw new CommandUsageException(
                $"{LaunchSettingDefinitions.HostDevRepositoryPath} is required for docker-host dev. Configure it with `docker-host config set {LaunchSettingDefinitions.HostDevRepositoryPath} /path/to/docker-host`, or pass --host-url <url> for an already running development Host.",
                Usage);
        }

        if (!Directory.Exists(configuredRepository))
        {
            throw new ConfigurationException($"{LaunchSettingDefinitions.HostDevRepositoryPath} does not exist: {configuredRepository}");
        }

        return configuredRepository;
    }

    private Process StartHostProcess(string repository, Uri origin, LaunchSettings settings)
    {
        var command = DefaultHostDevCommand;
        var startInfo = CreateShellStartInfo(command, repository);
        foreach (var (key, value) in BuildHostEnvironment(origin, settings))
        {
            startInfo.Environment[key] = value;
        }

        context.Console.MarkupLine($"[green]Starting Host command:[/] {Markup.Escape(command)}");
        context.Console.MarkupLine($"[grey]Host origin:[/] {Markup.Escape(origin.ToString().TrimEnd('/'))}");
        context.Console.MarkupLine($"[grey]Host working directory:[/] {Markup.Escape(repository)}");

        try
        {
            return Process.Start(startInfo)
                ?? throw new ConfigurationException("Unable to start Host command.");
        }
        catch (Exception ex) when (ex is not ConfigurationException)
        {
            throw new ConfigurationException($"Unable to start Host command: {ex.Message}", ex);
        }
    }

    private IReadOnlyDictionary<string, string> BuildHostEnvironment(Uri origin, LaunchSettings settings)
    {
        var dataRoot = settings.ResolveHostDataRoot(context.Environment);
        var values = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["HOST_DATA_ROOT_HOST"] = dataRoot,
            ["HOST_DATA_ROOT_CONTAINER"] = dataRoot,
            ["HOST_INTERNAL_ORIGIN"] = origin.ToString().TrimEnd('/'),
            ["HOST_CONTROL_PUBLIC_PORT"] = origin.Port.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["HOST_DEV_AUTH"] = ReadEnvironmentOverride("HOST_DEV_AUTH", "auto"),
            ["HOST_DEV_AUTH_SEED_BROWSER_ACCOUNTS"] = ReadEnvironmentOverride("HOST_DEV_AUTH_SEED_BROWSER_ACCOUNTS", "enabled"),
        };

        if (!values.ContainsKey("HOST_MODULE_DEV_MODE"))
        {
            values["HOST_MODULE_DEV_MODE"] = "enabled";
        }

        if (!values.ContainsKey("PORT") && origin.Port > 0 && !origin.IsDefaultPort)
        {
            values["PORT"] = origin.Port.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        return values;
    }

    private static string ReadEnvironmentOverride(string key, string fallback)
    {
        var value = Environment.GetEnvironmentVariable(key);
        return string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
    }

    private static Uri BuildLoopbackOrigin(int port)
        => new($"http://localhost:{port.ToString(System.Globalization.CultureInfo.InvariantCulture)}");

    private async Task<bool> WaitForLocalHostReadyAsync(Uri origin, Process process)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(60);
        HostApiException? lastError = null;
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (process.HasExited)
            {
                context.Console.MarkupLine($"[red]Local Host command exited before trusted control became ready.[/] Exit code: {process.ExitCode}");
                return false;
            }

            try
            {
                using var hostApi = CreateHostControlClient(origin);
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

        context.Console.MarkupLine("[red]Timed out waiting for the local Host trusted control channel.[/]");
        if (lastError is not null && !string.IsNullOrWhiteSpace(lastError.ResponseBody))
        {
            context.Console.MarkupLine($"[grey]Last error:[/] {Markup.Escape(lastError.ResponseBody)}");
        }

        return false;
    }

    private HostControlClient CreateHostControlClient(Uri hostOrigin)
    {
        var settings = context.SettingsStore.Load();
        settings.Validate(context.Environment);
        var discovery = HostControlDiscovery.Load(settings.ResolveHostDataRoot(context.Environment));
        var endpoint = new Uri(hostOrigin, "/control/v1/");
        return context.ControlFactory.Create(endpoint, discovery.Secret);
    }

    private async Task<bool> EnsureHostReadyAsync(HostControlClient hostApi)
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

    private static async Task<bool> IsHostReadyAsync(HostControlClient hostApi)
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

    private async Task SeedUsersAsync(HostControlClient hostApi, DevManifest manifest, string moduleId)
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

    private async Task RevokeExistingInvitationAsync(HostControlClient hostApi, UserInvitationSummary invitation)
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
        HostControlClient hostApi,
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
        HostControlClient hostApi,
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

    private async Task RemoveManifestAssignmentsAsync(HostControlClient hostApi, DevManifest manifest, string moduleId)
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

        context.Console.MarkupLine("[green]Development user assignments reset.[/]");
    }

    private async Task ApplyDirectoryPolicyAsync(HostControlClient hostApi, DevManifest manifest, string moduleId)
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
        var moduleDataRoot = EnsureDevModuleDataRoot(target.ModuleId);
        foreach (var (key, value) in BuildModuleEnvironment(manifest, hostUrl, target, moduleDataRoot))
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
        ModuleDevTargetSummary target,
        string moduleDataRoot)
    {
        var values = new Dictionary<string, string>(manifest.Environment, StringComparer.Ordinal)
        {
            ["DOCKER_HOST_INTERNAL_ORIGIN"] = hostUrl,
            ["DOCKER_HOST_MODULE_ID"] = target.ModuleId,
            ["DOCKER_HOST_MODULE_DATA_ROOT"] = moduleDataRoot,
            ["MODULE_ID"] = target.ModuleId,
            ["MODULE_VERSION"] = target.ModuleVersion,
        };

        return values;
    }

    private string EnsureDevModuleDataRoot(string moduleId)
    {
        var settings = context.SettingsStore.EnsureInstalled();
        var root = Path.Combine(settings.ResolveHostDataRoot(context.Environment), "dev", "modules", moduleId);
        Directory.CreateDirectory(root);
        return root;
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

    private LocalMetadataFileServer StartMetadataServer(DevManifest manifest)
    {
        var metadataFile = manifest.ResolveMetadataFile();
        var server = LocalMetadataFileServer.Start(
            metadataFile,
            IPAddress.Loopback.ToString(),
            ex => context.Console.MarkupLine($"[yellow]Metadata file server warning:[/] {Markup.Escape(ex.Message)}"),
            manifest.HostMetadataBytes);
        context.Console.MarkupLine($"[grey]Serving metadata file for Host fetch:[/] {Markup.Escape(server.PublicUrl)}");
        return server;
    }

    private static DevCommandOptions ParseOptions(string[] args, bool allowPrepareOnly)
    {
        var manifestPath = Path.Combine(Directory.GetCurrentDirectory(), "metadata.dev.json");
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

    private static DevCleanOptions ParseCleanOptions(string[] args)
    {
        var positionals = new List<string>();
        Uri? hostOrigin = null;
        var assumeYes = false;

        for (var index = 0; index < args.Length; index++)
        {
            var arg = args[index];
            switch (arg)
            {
                case "--host-url":
                case "--host-origin":
                    if (index + 1 >= args.Length)
                    {
                        throw new CommandUsageException($"{arg} requires a URL.", Usage);
                    }

                    hostOrigin = ParseHostOriginOverride(args[++index]);
                    break;
                case "--yes":
                case "-y":
                    assumeYes = true;
                    break;
                default:
                    if (arg.StartsWith("--", StringComparison.Ordinal))
                    {
                        throw new CommandUsageException($"Unknown dev clean option '{arg}'.", Usage);
                    }

                    positionals.Add(arg);
                    break;
            }
        }

        if (positionals.Count != 1)
        {
            throw new CommandUsageException("dev clean requires exactly one module id or dev metadata path.", Usage);
        }

        return new DevCleanOptions(positionals[0], hostOrigin, assumeYes);
    }

    private static string ResolveDevCleanModuleId(string value)
    {
        var candidatePath = Path.GetFullPath(value);
        if (Directory.Exists(candidatePath))
        {
            candidatePath = Path.Combine(candidatePath, "metadata.dev.json");
        }

        if (!File.Exists(candidatePath))
        {
            return value.Trim();
        }

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(candidatePath));
            if (document.RootElement.TryGetProperty("id", out var id) &&
                id.ValueKind == JsonValueKind.String &&
                !string.IsNullOrWhiteSpace(id.GetString()))
            {
                return id.GetString()!.Trim();
            }
        }
        catch (JsonException ex)
        {
            throw new CommandUsageException($"Dev metadata is not valid JSON: {ex.Message}", Usage);
        }

        throw new CommandUsageException("Dev metadata must include a module id.", Usage);
    }

    private static Uri ParseHostOriginOverride(string value)
    {
        if (!Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            throw new CommandUsageException("--host-url must be an absolute HTTP(S) URL.", Usage);
        }

        if (!IsLoopbackHost(uri.Host))
        {
            throw new CommandUsageException("--host-url must point to a loopback Host origin such as http://localhost:3000.", Usage);
        }

        return new Uri(uri.GetLeftPart(UriPartial.Authority));
    }

    private static bool IsLoopbackHost(string host)
    {
        if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var normalizedHost = host.Length >= 2 && host[0] == '[' && host[^1] == ']'
            ? host[1..^1]
            : host;
        return IPAddress.TryParse(normalizedHost, out var address) && IPAddress.IsLoopback(address);
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

internal sealed record DevCleanOptions(string Target, Uri? HostOrigin, bool AssumeYes);

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
