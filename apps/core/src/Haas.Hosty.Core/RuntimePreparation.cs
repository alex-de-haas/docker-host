namespace Haas.Hosty.Core;

internal sealed partial class LocalCommandRuntimeAdapter
{
    public async Task<RuntimePreparation> PrepareAsync(RuntimeLifecycleContext context, CancellationToken ct)
    {
        var locks = new Dictionary<string, ArtifactLock>(StringComparer.Ordinal);
        var prepared = new List<string>();
        foreach (var service in DockerRuntimeAdapter.OrderServices(context.Manifest.Services))
        {
            var directory = ResolveWorkingDirectory(context, service);
            if (service.Artifact == "prebuilt" && service.Runtime.Delivery is { } delivery)
            {
                var artifact = PrebuiltArtifactStore.Resolve(context.AppRoot, context.Manifest.RuntimeProfile.Key,
                    ResolveSourceRoot(context), delivery, null);
                directory = CombineWorkingDirectory(artifact.Item1, service.Runtime.WorkingDirectory);
                locks[service.Key] = artifact.Item2;
            }
            if (!Directory.Exists(directory)) throw new AppLifecycleException("activation_source_missing", "The candidate working directory is unavailable.");
            if (string.IsNullOrWhiteSpace(service.Runtime.Command)) throw new AppLifecycleException("local_command_missing", "The candidate has no command.");
            SecureFileSystem.EnsurePrivateDirectory(context.AppDataPath);
            SecureFileSystem.EnsurePrivateDirectory(context.AppCachePath!);
            using var log = new LocalCommandLogWriter(new StreamWriter(SecureFileSystem.CreatePrivateFile(
                Path.Combine(context.AppDataPath, service.Key + ".prepare.log"), FileMode.Append, FileShare.Read, FileOptions.None)) { AutoFlush = true });
            await RunSetupAsync(context with { PreparationOnly = true }, service, ResolveServicePorts(context), directory, log, ct);
            prepared.Add(service.Key);
        }
        return new(locks, prepared.ToArray());
    }
}

internal sealed partial class DockerRuntimeAdapter
{
    public async Task<RuntimePreparation> PrepareAsync(RuntimeLifecycleContext context, CancellationToken ct)
    {
        var locks = new Dictionary<string, ArtifactLock>(StringComparer.Ordinal);
        var setup = new List<string>();
        foreach (var service in OrderServices(context.Manifest.Services))
        {
            if (service.Image is null) throw new AppLifecycleException("runtime_profile_invalid", "The Docker service has no image.");
            var launch = await DockerSourceRuntime.PrepareAsync(context, service, runner, ct, config.InstanceId);
            var resolved = service.Runtime.Build is not null
                ? await DockerSourceRuntime.ResolveBuildAsync(context, service, runner, null, ct)
                : await ResolveImageRunReferenceAsync(service.Image, null, ct);
            if (launch is not null && resolved.Item2.ImageDigest is null)
                resolved = await DockerSourceRuntime.ResolveLocalImageAsync(resolved.Item1, null, runner, ct);
            locks[service.Key] = resolved.Item2;
            if (launch is not null && !string.IsNullOrWhiteSpace(service.Runtime.Setup))
            {
                var name = "hosty-prepare-" + Guid.NewGuid().ToString("N");
                var args = new List<string> { "run", "--rm", "--name", name, "--label", "hosty.instance=" + config.InstanceId };
                args.AddRange(launch.Arguments);
                foreach (var pair in service.Runtime.Environment) args.AddRange(["--env", pair.Key + "=" + pair.Value]);
                AppendPreparationStorageArguments(context, service.Key, args);
                args.AddRange([resolved.Item1, "/bin/sh", "-lc", service.Runtime.Setup]);
                try
                {
                    var result = await runner.RunAsync(args, null, ct);
                    if (result.ExitCode != 0) throw new AppLifecycleException("activation_setup_failed",
                        $"Preparation failed for {context.App.Id}/{service.Key}. No ordinary runtime was stopped.");
                }
                finally { await runner.RunAsync(["rm", "-f", name], null, CancellationToken.None); }
            }
            setup.Add(service.Key);
        }
        return new(locks, setup.ToArray());
    }

    private static void AppendPreparationStorageArguments(RuntimeLifecycleContext context, string service, List<string> args)
    {
        static bool Applies(RuntimeAppDataTarget? target, string service) => target is not null &&
            (string.IsNullOrWhiteSpace(target.Service) || string.Equals(target.Service, service, StringComparison.Ordinal));
        var data = context.Manifest.DataTarget;
        var cache = context.Manifest.CacheTarget;
        if (Applies(cache, service) && string.IsNullOrWhiteSpace(context.AppCachePath))
            throw new AppLifecycleException("activation_cache_path_missing", "Preparation requires an explicit scratch cache directory. Ordinary app cache was not mounted.");
        void Add(RuntimeAppDataTarget target, string host, string area, string defaultEnvironment)
        {
            var path = string.IsNullOrWhiteSpace(target.ContainerPath) ? "/app/" + area : target.ContainerPath;
            var environment = string.IsNullOrWhiteSpace(target.Environment) ? defaultEnvironment : target.Environment;
            Directory.CreateDirectory(host);
            args.AddRange(["-v", host + ":" + path, "--env", environment + "=" + path]);
        }
        // Match startup's service scoping, container defaults and target-env precedence, but use
        // only the explicit preparation scratch paths. Settings, identity and external mounts stay out.
        if (Applies(data, service)) Add(data!, context.AppDataPath, "data", "HOSTY_APP_DATA_DIR");
        if (Applies(cache, service)) Add(cache!, context.AppCachePath!, "cache", "HOSTY_APP_CACHE_DIR");
    }
}
