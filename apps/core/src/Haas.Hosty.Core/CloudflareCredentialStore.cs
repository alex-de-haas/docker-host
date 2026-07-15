namespace Haas.Hosty.Core;

// One-click Cloudflare public ingress, phase 1: the private at-rest store for the scoped Cloudflare API
// token. The raw token is written owner-only (0600 via JsonStorage restrictToOwner) under the private core
// data root, is never returned to any API/UI projection (only a masked summary is), and is never logged.
// The connector's own token is not stored — the existing connector stays externally owned. See
// docs/planning/one-click-cloudflare-public-ingress.md ("Provider And State Boundaries").
internal sealed class CloudflareCredentialStore(CoreDataPaths paths)
{
    private readonly SemaphoreSlim gate = new(1, 1);

    private string CredentialPath => Path.Combine(paths.CoreRoot, "cloudflare-credential.json");

    public async Task SaveAsync(CloudflareCredential credential, CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await JsonStorage.WriteAsync(CredentialPath, credential, restrictToOwner: true, cancellationToken);
        }
        finally
        {
            gate.Release();
        }
    }

    // Returns the raw credential (including the token) for the API client only. Callers must never surface
    // the token to Shell, logs, or API responses — use GetSummaryAsync for anything user-facing. Reads under
    // the same gate as writes/deletes so a concurrent Save/Delete cannot race the read.
    public async Task<CloudflareCredential?> LoadAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            return await JsonStorage.ReadAsync<CloudflareCredential>(CredentialPath, cancellationToken);
        }
        finally
        {
            gate.Release();
        }
    }

    // The user-facing projection: presence + non-secret metadata + a masked token, never the raw value.
    public async Task<CloudflareCredentialSummary> GetSummaryAsync(CancellationToken cancellationToken = default)
    {
        var credential = await LoadAsync(cancellationToken);
        return credential is null
            ? new CloudflareCredentialSummary(false, null, null, null, null)
            : new CloudflareCredentialSummary(true, credential.TokenId, credential.TokenName, credential.ExpiresOn, Mask(credential.Token));
    }

    public async Task DeleteAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            if (File.Exists(CredentialPath))
            {
                File.Delete(CredentialPath);
            }
        }
        finally
        {
            gate.Release();
        }
    }

    // Show only the first and last few characters so a summary can identify which token is stored without
    // exposing it. Very short values are fully masked.
    internal static string Mask(string token)
    {
        if (string.IsNullOrEmpty(token))
        {
            return "";
        }

        return token.Length <= 8 ? new string('•', token.Length) : $"{token[..4]}…{token[^4..]}";
    }
}

// The at-rest credential: the raw token plus non-secret metadata Cloudflare's verify returns.
internal sealed record CloudflareCredential(string Token, string? TokenId, string? TokenName, DateTimeOffset? ExpiresOn);

// The user-facing projection. `Masked` is a display hint (e.g. "abcd…wxyz"), never the raw token; null when
// no token is stored.
internal sealed record CloudflareCredentialSummary(bool Present, string? TokenId, string? TokenName, DateTimeOffset? ExpiresOn, string? Masked);
