namespace Haas.Hosty.Core;

// Full actor-owned inventories make every frame independently usable, including after queue loss.
// Null means unavailable, never empty: keep previously displayed resources on observation failure.
internal sealed record SandboxStreamSnapshot(IReadOnlyList<CoreEnvironmentView>? Environments,
    IReadOnlyList<SandboxView>? Instances, string? CoreError = null, string? AppError = null)
{
    internal static async Task<SandboxStreamSnapshot> ReadAsync(IServiceProvider services, string userId, CancellationToken ct)
    {
        IReadOnlyList<CoreEnvironmentView>? environments = null;
        IReadOnlyList<SandboxView>? instances = null;
        string? coreError = null, appError = null;
        var actor = new SandboxActor(userId);
        try { environments = (await services.GetRequiredService<CoreEnvironmentService>().ListAsync(actor, ct, observe: false)).Environments; }
        catch (Exception ex) when (ex is SandboxException or IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        { coreError = "Core sandbox inventory is unavailable. Refresh to retry."; }
        try { instances = (await services.GetRequiredService<SandboxService>().ListAsync(actor, ct)).Instances; }
        catch (Exception ex) when (ex is SandboxException or IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        { appError = "Application sandbox inventory is unavailable. Refresh to retry."; }
        return new(environments, instances, coreError, appError);
    }
}
