namespace Haas.Hosty.Core;

internal sealed class AppAuthCodeStore(CoreDataPaths paths)
{
    private string StatePath => Path.Combine(paths.AuthRoot, "app-auth-codes.json");

    public async Task<AppAuthCodeState> ReadAsync(CancellationToken cancellationToken = default)
        => await JsonStorage.ReadAsync<AppAuthCodeState>(StatePath, cancellationToken) ??
            new AppAuthCodeState(1, []);

    public async Task WriteAsync(AppAuthCodeState state, CancellationToken cancellationToken = default)
        => await JsonStorage.WriteAsync(StatePath, state, cancellationToken);
}

internal sealed record AppAuthCodeState(int SchemaVersion, IReadOnlyList<AppAuthCodeRecord> Codes);

internal sealed record AppAuthCodeRecord(
    string Code,
    string AppId,
    string UserId,
    string RedirectUri,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? ConsumedAt);
