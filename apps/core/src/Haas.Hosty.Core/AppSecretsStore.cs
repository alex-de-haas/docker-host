using System.Text;
using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

// Core-managed keychain for runtime-acquired app secrets (e.g. OAuth tokens an app must present to a
// third-party API). Persisted to apps/<id>/secrets.json beside state.json — outside the backed-up
// data/ directory, so a backup archive never carries live credentials. Apps reach it only through
// AppSecretsEndpoints with their service token; containers never see the file.
//
// Serializes on AppRegistryStore's per-app lock rather than its own: secrets mutations, state.json
// writes, and the RemoveAppAsync subtree delete contend on one semaphore. Two fences keep a write
// that loses the race to a removal from resurrecting credentials the operator asked to delete:
// state.json existence (covers the default removal, which deletes it) and the registry's per-app
// data-removal generation (covers `--delete-data --keep-state`, where state.json survives).
// See docs/features/app-secrets-store/feature.md.
internal sealed class AppSecretsStore(AppRegistryStore apps, CoreDataPaths paths)
{
    public const int MaxValueBytes = 16 * 1024;
    public const int MaxKeysPerApp = 256;

    private static readonly Regex KeyPattern = new("^[a-z0-9][a-z0-9._-]{0,127}$", RegexOptions.Compiled);

    public static bool IsValidKey(string? key)
        => !string.IsNullOrEmpty(key) && KeyPattern.IsMatch(key);

    // Non-empty and bounded; oversize values are rejected, never truncated.
    public static bool IsValidValue(string? value)
        => !string.IsNullOrEmpty(value) && Encoding.UTF8.GetByteCount(value) <= MaxValueBytes;

    public async Task<AppSecretsListResult> ListKeysAsync(string appId, CancellationToken cancellationToken = default)
    {
        if (!TryResolveSecretsPath(appId, out var secretsPath, out var statePath))
        {
            return new AppSecretsListResult(AppSecretsStatus.AppNotFound, []);
        }

        var mutex = apps.GetAppLock(appId);
        await mutex.WaitAsync(cancellationToken);
        try
        {
            if (!File.Exists(statePath))
            {
                return new AppSecretsListResult(AppSecretsStatus.AppNotFound, []);
            }

            var secrets = await ReadSecretsAsync(secretsPath, cancellationToken);
            return new AppSecretsListResult(
                AppSecretsStatus.Ok,
                secrets.Keys.Order(StringComparer.Ordinal).ToArray());
        }
        finally
        {
            mutex.Release();
        }
    }

    public async Task<AppSecretsValueResult> GetAsync(string appId, string key, CancellationToken cancellationToken = default)
    {
        if (!TryResolveSecretsPath(appId, out var secretsPath, out var statePath))
        {
            return new AppSecretsValueResult(AppSecretsStatus.AppNotFound, null);
        }

        var mutex = apps.GetAppLock(appId);
        await mutex.WaitAsync(cancellationToken);
        try
        {
            if (!File.Exists(statePath))
            {
                return new AppSecretsValueResult(AppSecretsStatus.AppNotFound, null);
            }

            var secrets = await ReadSecretsAsync(secretsPath, cancellationToken);
            return secrets.TryGetValue(key, out var entry)
                ? new AppSecretsValueResult(AppSecretsStatus.Ok, entry.Value)
                : new AppSecretsValueResult(AppSecretsStatus.KeyNotFound, null);
        }
        finally
        {
            mutex.Release();
        }
    }

    public async Task<AppSecretsStatus> SetAsync(string appId, string key, string value, CancellationToken cancellationToken = default)
    {
        // Bounds are enforced here as well as at the endpoint: the store is reachable from other Core
        // code, and the persisted document's limits are its own invariant, not the HTTP layer's.
        if (!IsValidKey(key))
        {
            return AppSecretsStatus.KeyInvalid;
        }

        if (!IsValidValue(value))
        {
            return AppSecretsStatus.ValueInvalid;
        }

        if (!TryResolveSecretsPath(appId, out var secretsPath, out var statePath))
        {
            return AppSecretsStatus.AppNotFound;
        }

        // Sampled before queueing on the lock, re-checked inside it (see the fences below).
        var generation = apps.ReadDataRemovalGeneration(appId);
        var mutex = apps.GetAppLock(appId);
        await mutex.WaitAsync(cancellationToken);
        try
        {
            // Removal fences. state.json is deleted by an ordinary removal before DeleteAllAsync
            // runs; under `--delete-data --keep-state` it survives, so the generation is what
            // catches a write already queued on this lock when the secrets were deleted. A request
            // that starts after the removal samples the new generation and proceeds normally.
            if (!File.Exists(statePath) || apps.ReadDataRemovalGeneration(appId) != generation)
            {
                return AppSecretsStatus.AppNotFound;
            }

            var secrets = await ReadSecretsAsync(secretsPath, cancellationToken);
            if (!secrets.ContainsKey(key) && secrets.Count >= MaxKeysPerApp)
            {
                return AppSecretsStatus.TooManyKeys;
            }

            secrets[key] = new AppSecretEntry(value, DateTimeOffset.UtcNow);
            // Owner-only like state.json: the value is the secret, the directory must stay traversable.
            await JsonStorage.WriteOwnerFileAsync(secretsPath, new AppSecretsDocument(1, secrets), cancellationToken);
            return AppSecretsStatus.Ok;
        }
        finally
        {
            mutex.Release();
        }
    }

    // Idempotent: deleting an absent key succeeds without a write.
    public async Task<AppSecretsStatus> DeleteAsync(string appId, string key, CancellationToken cancellationToken = default)
    {
        if (!TryResolveSecretsPath(appId, out var secretsPath, out var statePath))
        {
            return AppSecretsStatus.AppNotFound;
        }

        var mutex = apps.GetAppLock(appId);
        await mutex.WaitAsync(cancellationToken);
        try
        {
            if (!File.Exists(statePath))
            {
                return AppSecretsStatus.AppNotFound;
            }

            var secrets = await ReadSecretsAsync(secretsPath, cancellationToken);
            if (secrets.Remove(key))
            {
                await JsonStorage.WriteOwnerFileAsync(secretsPath, new AppSecretsDocument(1, secrets), cancellationToken);
            }

            return AppSecretsStatus.Ok;
        }
        finally
        {
            mutex.Release();
        }
    }

    // Removal path (delete-data). Runs under the same lock as every mutation, so an in-flight write
    // either lands first and is deleted here, or arrives after and is refused: by the state.json
    // fence on an ordinary removal, and by the epoch bump when the operator kept the runtime state.
    public async Task DeleteAllAsync(string appId, CancellationToken cancellationToken = default)
    {
        if (!TryResolveSecretsPath(appId, out var secretsPath, out _))
        {
            return;
        }

        var mutex = apps.GetAppLock(appId);
        await mutex.WaitAsync(cancellationToken);
        try
        {
            apps.BumpDataRemovalGeneration(appId);
            if (File.Exists(secretsPath))
            {
                File.Delete(secretsPath);
            }
        }
        finally
        {
            mutex.Release();
        }
    }

    private bool TryResolveSecretsPath(string appId, out string secretsPath, out string statePath)
    {
        secretsPath = string.Empty;
        statePath = string.Empty;
        if (!CoreDataPaths.TryResolveContainedPath(paths.AppsRoot, appId, out var appRoot))
        {
            return false;
        }

        secretsPath = Path.Combine(appRoot, "secrets.json");
        statePath = Path.Combine(appRoot, "state.json");
        return true;
    }

    // Missing file reads as an empty store; a malformed file fails loud (JsonException propagates)
    // rather than being silently replaced — that would be silent credential loss.
    private static async Task<Dictionary<string, AppSecretEntry>> ReadSecretsAsync(string secretsPath, CancellationToken cancellationToken)
    {
        var document = await JsonStorage.ReadAsync<AppSecretsDocument>(secretsPath, cancellationToken);
        if (document is null)
        {
            return new Dictionary<string, AppSecretEntry>(StringComparer.Ordinal);
        }

        if (document.SchemaVersion != 1)
        {
            throw new InvalidOperationException(
                $"Unsupported app secrets schema version {document.SchemaVersion} in '{secretsPath}'.");
        }

        return document.Secrets is null
            ? new Dictionary<string, AppSecretEntry>(StringComparer.Ordinal)
            : new Dictionary<string, AppSecretEntry>(document.Secrets, StringComparer.Ordinal);
    }
}

internal enum AppSecretsStatus
{
    Ok,
    AppNotFound,
    KeyNotFound,
    TooManyKeys,
    KeyInvalid,
    ValueInvalid,
}

internal sealed record AppSecretsListResult(AppSecretsStatus Status, IReadOnlyList<string> Keys);

internal sealed record AppSecretsValueResult(AppSecretsStatus Status, string? Value);

// UpdatedAt is file-internal diagnostics, not exposed through the API. The schema version exists so
// a future at-rest encryption pass is a lazy migration, not a format break.
internal sealed record AppSecretsDocument(int SchemaVersion, Dictionary<string, AppSecretEntry>? Secrets);

internal sealed record AppSecretEntry(string Value, DateTimeOffset UpdatedAt);
