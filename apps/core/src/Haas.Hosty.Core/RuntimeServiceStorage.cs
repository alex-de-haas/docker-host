using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

/// <summary>Resolves service-scoped app data and cache without exposing unrelated app storage.</summary>
internal static class RuntimeServiceStorage
{
    internal sealed record Binding(RuntimeAppDataTarget Target, bool Cache, string Environment, string ContainerPath);

    internal static IReadOnlyList<Binding> Resolve(RuntimeAppManifestSelection selection, RuntimeSelectedService service)
        => Resolve(selection.Manifest, selection.RuntimeProfile, service);

    private static IReadOnlyList<Binding> Resolve(RuntimeAppManifest manifest, RuntimeProfileManifest profile, RuntimeSelectedService service)
    {
        var result = new List<Binding>();
        foreach (var (storage, cache) in new[] { (manifest.Data, false), (manifest.Cache, true) })
        {
            if (storage?.Enabled != true)
            {
                // Local commands historically receive app data even without a data declaration.
                // Enabled storage still follows explicit service targets, including exclusions.
                if (!cache && service.Runtime.Type == "localCommand")
                    result.Add(new(new RuntimeAppDataTarget(), false, "HOSTY_APP_DATA_DIR", "/app/data"));
                continue;
            }
            var name = cache ? "cache" : "data";
            string EnvironmentName(RuntimeAppDataTarget t) => string.IsNullOrWhiteSpace(t.Environment) ? $"HOSTY_APP_{name.ToUpperInvariant()}_DIR" : t.Environment;
            var applicable = storage.Targets.Where(t => string.IsNullOrEmpty(t.Service) || t.Service == service.Key).ToArray();
            var exact = applicable.Where(t => t.Runtime == profile.Key).ToArray();
            var selected = exact.Concat(applicable.Where(t => t.Runtime == profile.Type && t.Runtime != profile.Key
                && !exact.Any(e => EnvironmentName(e) == EnvironmentName(t)))).ToArray();
            // Preserve implicit storage only when the profile has no explicit target at all.
            if (selected.Length == 0 && !storage.Targets.Any(t => t.Runtime == profile.Key || t.Runtime == profile.Type))
            {
                var first = manifest.Services.FirstOrDefault(candidate => candidate.Runtimes.ContainsKey(profile.Key))?.Key;
                // Legacy Docker defaults expose app storage only to the first selected service.
                if (service.Runtime.Type != "docker" || first is null || service.Key == first)
                    selected = [new RuntimeAppDataTarget()];
            }
            result.AddRange(selected.Select(t => new Binding(t, cache, EnvironmentName(t), string.IsNullOrWhiteSpace(t.ContainerPath) ? $"/app/{name}" : t.ContainerPath)));
        }
        return result;
    }

    internal static void Validate(RuntimeAppManifest manifest, RuntimeProfileManifest profile,
        IReadOnlyList<RuntimeSelectedService> services, List<AppManifestValidationError> errors)
    {
        foreach (var service in services)
        {
            if (service.Injection?.Settings is { } settings && (settings.Distinct(StringComparer.Ordinal).Count() != settings.Count
                || settings.Any(key => !manifest.Settings.Any(setting => setting.Key == key))))
                errors.Add(new("app_manifest_injection_invalid", "Service settings injection must name unique declared settings.", "$.services[].injection.settings"));
            if (service.Injection is { } injection && service.Runtime.Environment.Keys.Any(key =>
                key == "HOSTY_APP_SERVICE_TOKEN" && injection.AppServiceToken == false
                || key == "HOSTY_APP_IDENTITY_TOKEN" && injection.AppIdentityToken == false
                || injection.Settings is { } allowed && manifest.Settings.Any(setting => setting.Key == key) && !allowed.Contains(key)))
                errors.Add(new("app_manifest_injection_override", "Runtime environment cannot override disabled credential/settings injection.", "$.services[].runtimes"));
            var bindings = Resolve(manifest, profile, service);
            var environments = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var destinations = new List<string>();
            foreach (var binding in bindings)
            {
                var target = binding.Target;
                if (!ValidSubPath(target.SubPath) || target.Mode is not ("ro" or "rw"))
                    errors.Add(new("app_manifest_storage_target_invalid", "Storage subPath must be a contained relative path and mode must be ro or rw.", "$.data/cache.targets"));
                if (!Regex.IsMatch(binding.Environment, "^[A-Za-z_][A-Za-z0-9_]*$") || !environments.Add(binding.Environment))
                    errors.Add(new("app_manifest_storage_environment_invalid", "Storage environment variables must be valid and unique per service.", "$.data/cache.targets"));
                if (service.Runtime.Type != "docker") continue;
                var destination = binding.ContainerPath.TrimEnd('/');
                if (!destination.StartsWith('/') || destination.Contains('\\') || destination.Contains(':')
                    || destination.Split('/').Any(part => part is "." or "..") || destination.Length < 2
                    || destinations.Any(other => destination == other || destination.StartsWith(other + "/", StringComparison.Ordinal)
                        || other.StartsWith(destination + "/", StringComparison.Ordinal)))
                    errors.Add(new("app_manifest_storage_destination_invalid", "Storage destinations must be absolute, distinct and non-overlapping container paths.", "$.data/cache.targets"));
                destinations.Add(destination);
            }
        }
        foreach (var target in (manifest.Data?.Targets ?? []).Concat(manifest.Cache?.Targets ?? []))
            if (target.Service is { } key && !manifest.Services.Any(service => service.Key == key))
                errors.Add(new("app_manifest_storage_service_unknown", "Storage target names an unknown service.", "$.data/cache.targets"));
    }

    internal static bool ValidSubPath(string? value)
        => value is null || value.Length > 0 && !value.StartsWith('/') && !value.Contains('\\') && !value.Contains(':')
            && !value.Contains('\0') && value.Split('/').All(part => part.Length > 0 && part is not ("." or ".."));

    internal static string PreparePath(string root, string? subPath)
    {
        if (!ValidSubPath(subPath)) throw new AppLifecycleException("app_storage_path_invalid", "Invalid app storage subPath.");
        Directory.CreateDirectory(root);
        var realRoot = MountPathPolicy.ResolveRealPath(root);
        var candidate = subPath is null ? realRoot : Path.Combine(realRoot, subPath.Replace('/', Path.DirectorySeparatorChar));
        var real = MountPathPolicy.ResolveRealPath(candidate);
        if (!MountPathPolicy.PathEqualsOrWithin(realRoot, real))
            throw new AppLifecycleException("app_storage_path_escape", "App storage target escapes its data/cache root.");
        var existed = Directory.Exists(real);
        Directory.CreateDirectory(real);
        if (!existed && !OperatingSystem.IsWindows()) File.SetUnixFileMode(real, File.GetUnixFileMode(realRoot));
        return real;
    }
}
