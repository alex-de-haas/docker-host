namespace Haas.Hosty.Core;

internal sealed partial class CoreLifecycleService
{
    public Task<AppLifecycleResponse> ConfigureSharedMountsAsync(
        string appId, string name, AppSharedMountsRequest request, CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, async () =>
        {
            if (request.Keys is null || request.ExpectedKeys is null)
                throw new AppLifecycleException("app_mount_keys_required", "Both keys and expectedKeys are required; use an empty list for no bindings.");

            var registry = await globalMounts.ReadAsync(cancellationToken);
            if (!registry.Mounts.Any(mount => mount.Name == name))
                throw new AppLifecycleException("global_mount_not_found", $"Shared mount '{name}' was not found.");

            var document = await apps.UpdateAppAsync(appId, current =>
            {
                var bindings = current.Mounts ?? [];
                var existingKeys = bindings.Where(binding => binding.GlobalMountName == name)
                    .Select(binding => binding.Key).Order(StringComparer.Ordinal);
                if (!existingKeys.SequenceEqual(request.ExpectedKeys.Order(StringComparer.Ordinal), StringComparer.Ordinal))
                    throw new AppLifecycleException("app_mount_bindings_changed", "These shared mount bindings changed. Reload the assignments and review your changes again.");

                // Merge under the app lock and registry transaction. A concurrent edit to another
                // shared mount or an inline binding must never be overwritten by this editor.
                var inputs = bindings.Where(binding => binding.GlobalMountName != name)
                    .Select(binding => new AppMountBindingInput(binding.Key, binding.Label, binding.HostPath, binding.GlobalMountName))
                    .Concat(request.Keys.Select(key => new AppMountBindingInput(key, GlobalMountName: name))).ToArray();
                return AppConfigurationFingerprint.CaptureLegacyBaseline(current, registry) with
                {
                    Mounts = ValidateMountBindings(current, inputs, registry),
                    OperationStatus = "configured", LastOperation = "configure-mounts", LastError = null,
                };
            }, cancellationToken);
            return new AppLifecycleResponse(await BuildAppSummaryAsync(document.App, cancellationToken), null, "configured");
        }, cancellationToken);
}

// Each request changes one shared mount in one app. The expected keys protect against stale edits
// to this mount; unrelated bindings are merged from the latest record rather than sent by the client.
internal sealed record AppSharedMountsRequest(IReadOnlyList<string>? Keys = null, IReadOnlyList<string>? ExpectedKeys = null);
