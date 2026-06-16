namespace Haas.Hosty.Core;

internal static class AppBackupEndpoints
{
    private const int MaxNoteLength = 200;

    public static void Map(WebApplication app)
    {
        // App-authenticated, on-demand backup. An app calls this with its service token
        // before a risky local operation (e.g. applying its own database migrations) so it
        // has a restorable snapshot to fall back on. Recorded under the retention-managed
        // "app-initiated" reason so repeated requests do not accumulate unbounded archives.
        app.MapPost("/api/internal/apps/{appId}/backups", async (
            string appId,
            HttpRequest request,
            AppInitiatedBackupRequest? input,
            AppServiceTokenService serviceTokens,
            AppRegistryStore apps,
            AppBackupService backups,
            AuditStore audit,
            IClock clock,
            CancellationToken cancellationToken) =>
        {
            var token = CoreSessionAuthorization.ReadBearerToken(request);
            if (string.IsNullOrWhiteSpace(token) || !serviceTokens.ValidateToken(appId, token))
            {
                return CoreJson.Json(
                    new ErrorResponse("app_backup_unauthorized", "App service token is missing or invalid."),
                    statusCode: StatusCodes.Status401Unauthorized);
            }

            if (await apps.GetAppAsync(appId, cancellationToken) is null)
            {
                return CoreJson.Json(
                    new ErrorResponse("app_not_found", "Runtime app was not found."),
                    statusCode: StatusCodes.Status404NotFound);
            }

            var note = input?.Note?.Trim();
            if (note is { Length: > MaxNoteLength })
            {
                return CoreJson.Json(
                    new ErrorResponse("app_backup_note_too_long", $"Backup note must be at most {MaxNoteLength} characters."),
                    statusCode: StatusCodes.Status400BadRequest);
            }

            if (string.IsNullOrWhiteSpace(note))
            {
                note = null;
            }

            AppBackupRecord? record;
            try
            {
                record = await backups.CreateBackupAsync(appId, AppBackupService.AppInitiatedReason, note, cancellationToken);
            }
            catch (AppLifecycleException ex)
            {
                return CoreJson.Json(
                    new ErrorResponse(ex.Code, ex.Message),
                    statusCode: StatusCodes.Status500InternalServerError);
            }

            // No data directory yet (nothing to snapshot): report a no-op so the app can
            // safely proceed rather than treating a missing backup as a failure.
            if (record is null)
            {
                return CoreJson.Json(
                    new AppInitiatedBackupResponse(
                        Status: "empty",
                        BackupId: null,
                        Reason: AppBackupService.AppInitiatedReason,
                        Note: note,
                        CreatedAt: null,
                        ArchiveSize: null,
                        FileCount: null),
                    statusCode: StatusCodes.Status200OK);
            }

            await audit.AppendAsync(
                new AuditRecord(
                    Id: $"audit_{Guid.NewGuid():N}",
                    Action: "backup.app.create",
                    ResourceType: "app.backup",
                    ResourceId: record.BackupId,
                    Outcome: "succeeded",
                    ActorUserId: null,
                    CreatedAt: clock.UtcNow,
                    Details: new Dictionary<string, string>(StringComparer.Ordinal)
                    {
                        ["appId"] = appId,
                        ["reason"] = record.Reason,
                    }),
                cancellationToken);

            return CoreJson.Json(
                new AppInitiatedBackupResponse(
                    Status: "completed",
                    BackupId: record.BackupId,
                    Reason: record.Reason,
                    Note: record.Note,
                    CreatedAt: record.CreatedAt,
                    ArchiveSize: record.ArchiveSize,
                    FileCount: record.FileCount),
                statusCode: StatusCodes.Status201Created);
        });
    }
}

internal sealed record AppInitiatedBackupRequest(string? Note);

internal sealed record AppInitiatedBackupResponse(
    string Status,
    string? BackupId,
    string Reason,
    string? Note,
    DateTimeOffset? CreatedAt,
    long? ArchiveSize,
    int? FileCount);
