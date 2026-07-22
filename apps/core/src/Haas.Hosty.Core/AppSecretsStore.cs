using System.Text;
using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

// Core-managed keychain for runtime-acquired app secrets (e.g. OAuth tokens an app must present to a
// third-party API). Persisted to apps/<id>/secrets.json beside state.json — outside the backed-up
// data/ directory, so a backup archive never carries live credentials. Apps reach it only through
// AppSecretsEndpoints with their service token; containers never see the file.
//
// Serializes on AppRegistryStore's per-app lock rather than its own: secrets mutations, state.json
// writes, and the RemoveAppAsync subtree delete contend on one semaphore, and every mutation
// re-checks state.json existence inside the lock. A write that loses the race to removal observes
// the deleted state.json and returns AppNotFound instead of resurrecting the app root with a stale
// secrets.json. See docs/planning/app-secrets-store.md.
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
        if (!TryResolveSecretsPath(appId, out var secretsPath, out var statePath))
        {
            return AppSecretsStatus.AppNotFound;
        }

        var mutex = apps.GetAppLock(appId);
        await mutex.WaitAsync(cancellationToken);
        try
        {
            // The removal fence: state.json is deleted by removal before DeleteAllAsync runs, so a
            // write arriving after that point must refuse rather than recreate the app root.
            if (!File.Exists(statePath))
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
    // either lands first and is deleted here, or arrives after and fails the state.json fence.
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
}

internal sealed record AppSecretsListResult(AppSecretsStatus Status, IReadOnlyList<string> Keys);

internal sealed record AppSecretsValueResult(AppSecretsStatus Status, string? Value);

// UpdatedAt is file-internal diagnostics, not exposed through the API. The schema version exists so
// a future at-rest encryption pass is a lazy migration, not a format break.
internal sealed record AppSecretsDocument(int SchemaVersion, Dictionary<string, AppSecretEntry>? Secrets);

internal sealed record AppSecretEntry(string Value, DateTimeOffset UpdatedAt);
