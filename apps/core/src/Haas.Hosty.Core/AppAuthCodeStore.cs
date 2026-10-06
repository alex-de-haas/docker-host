namespace Haas.Hosty.Core;

internal sealed class AppAuthCodeStore(CoreDataPaths paths)
{
    private readonly SemaphoreSlim mutex = new(1, 1);

    private string StatePath => Path.Combine(paths.AuthRoot, "app-auth-codes.json");

    public async Task<AppAuthCodeState> ReadAsync(CancellationToken cancellationToken = default)
        => await JsonStorage.ReadAsync<AppAuthCodeState>(StatePath, cancellationToken) ??
            new AppAuthCodeState(1, []);

    public async Task AppendCodeAsync(AppAuthCodeRecord record, DateTimeOffset now, CancellationToken cancellationToken = default)
    {
        await mutex.WaitAsync(cancellationToken);
        try
        {
            var state = await ReadAsync(cancellationToken);
            var nextCodes = state.Codes
                .Where(candidate => candidate.ExpiresAt > now && candidate.ConsumedAt is null)
                .Append(record)
                .ToArray();
            await JsonStorage.WriteAsync(StatePath, state with { Codes = nextCodes }, restrictToOwner: true, cancellationToken);
        }
        finally
        {
            mutex.Release();
        }
    }

    public async Task<AppAuthCodeConsumeResult> ConsumeCodeAsync(string? code, string callingAppId, string? codeVerifier, DateTimeOffset now, CancellationToken cancellationToken = default)
    {
        await mutex.WaitAsync(cancellationToken);
        try
        {
            var state = await ReadAsync(cancellationToken);
            var match = state.Codes.FirstOrDefault(candidate => string.Equals(candidate.Code, code, StringComparison.Ordinal));
            if (match is null)
            {
                return new AppAuthCodeConsumeResult(AppAuthCodeConsumeOutcome.NotFound, null);
            }

            // Match and consume under one lock. A foreign app cannot burn the code or learn
            // whether its rightful owner has already used it or its lifetime has ended.
            if (!string.Equals(match.AppId, callingAppId, StringComparison.Ordinal))
            {
                return new AppAuthCodeConsumeResult(AppAuthCodeConsumeOutcome.AppMismatch, match);
            }

            // An old unbound record and an unrelated proof disclose neither consumption nor expiry.
            // A refused proof never burns the rightful browser's code.
            if (!AppCodeProof.Matches(match.CodeChallenge, codeVerifier))
                return new AppAuthCodeConsumeResult(AppAuthCodeConsumeOutcome.ProofMismatch, match);

            if (match.ConsumedAt is not null)
            {
                return new AppAuthCodeConsumeResult(AppAuthCodeConsumeOutcome.AlreadyConsumed, match);
            }

            if (match.ExpiresAt <= now)
            {
                return new AppAuthCodeConsumeResult(AppAuthCodeConsumeOutcome.Expired, match);
            }

            var consumed = match with { ConsumedAt = now };
            var nextCodes = state.Codes
                .Select(candidate => string.Equals(candidate.Code, code, StringComparison.Ordinal) ? consumed : candidate)
                .Where(candidate => string.Equals(candidate.Code, code, StringComparison.Ordinal) ||
                    (candidate.ExpiresAt > now && candidate.ConsumedAt is null))
                .ToArray();
            await JsonStorage.WriteAsync(StatePath, state with { Codes = nextCodes }, restrictToOwner: true, cancellationToken);
            return new AppAuthCodeConsumeResult(AppAuthCodeConsumeOutcome.Consumed, consumed);
        }
        finally
        {
            mutex.Release();
        }
    }
}

internal enum AppAuthCodeConsumeOutcome
{
    Consumed,
    NotFound,
    AppMismatch,
    ProofMismatch,
    AlreadyConsumed,
    Expired,
}

internal sealed record AppAuthCodeConsumeResult(AppAuthCodeConsumeOutcome Outcome, AppAuthCodeRecord? Record);

internal sealed record AppAuthCodeState(int SchemaVersion, IReadOnlyList<AppAuthCodeRecord> Codes);

internal sealed record AppAuthCodeRecord(
    string Code,
    string AppId,
    string UserId,
    string RedirectUri,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? ConsumedAt,
    // The Core session that authorized this code, carried onto the issued grant so an explicit logout can
    // cascade-revoke it. Null only for authenticated non-browser issuers without a parent session.
    string? AuthorizingSessionId = null,
    string? AuthRevision = null,
    bool ActivityAuthorized = false,
    string? CodeChallenge = null);
