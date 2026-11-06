namespace Haas.Hosty.Core;

// Full actor-owned inventories make every frame independently usable, including after queue loss.
// Null means unavailable, never empty: keep previously displayed resources on observation failure.
internal sealed record SandboxStreamSnapshot(IReadOnlyList<CoreEnvironmentView>? Environments,
    string? CoreError = null)
{
    internal static async Task<SandboxStreamSnapshot> ReadAsync(IServiceProvider services, string userId, CancellationToken ct)
    {
        IReadOnlyList<CoreEnvironmentView>? environments = null;
        string? coreError = null;
        var actor = new SandboxActor(userId);
        try { environments = (await services.GetRequiredService<CoreEnvironmentService>().ListAsync(actor, ct, observe: false)).Environments; }
        catch (Exception ex) when (ex is SandboxException or IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        { coreError = "Environment inventory is unavailable. Retry to refresh."; }
        return new(environments, coreError);
    }
}
