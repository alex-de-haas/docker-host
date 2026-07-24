namespace Haas.Hosty.Core;

internal static class NotificationEndpoints
{
    private const int MaxTitleLength = 120;
    private const int MaxBodyLength = 2000;

    public static void Map(WebApplication app)
    {
        // App-authenticated producer. An app emits a user-targeted notification with its service
        // token; recipients are scoped to the app's directory and the audience is always "user".
        app.MapPost("/api/internal/apps/{appId}/notifications", (
            string appId,
            HttpRequest request,
            AppNotificationCreateRequest? input,
            AppServiceTokenService serviceTokens,
            AppRegistryStore apps,
            NotificationService notifications,
            AuditStore audit,
            IClock clock,
            CancellationToken cancellationToken) =>
            PublishFromAppAsync(appId, request, input, serviceTokens, apps, notifications, audit, clock, cancellationToken));

        // Session-authenticated consumer: the signed-in Host user's own inbox. Client-agnostic —
        // the Shell bell and any other Core-session client read this same stream.
        app.MapGet("/api/notifications", (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            NotificationService notifications,
            CancellationToken cancellationToken) =>
            ListForSessionAsync(request, users, clock, notifications, cancellationToken));

        app.MapPost("/api/notifications/read", (
            HttpRequest request,
            NotificationMarkReadRequest? input,
            UserDirectoryStore users,
            IClock clock,
            NotificationService notifications,
            CancellationToken cancellationToken) =>
            MarkReadForSessionAsync(request, input, users, clock, notifications, cancellationToken));

        // Live delivery moved to the unified GET /api/events stream (see EventStreamEndpoints).
        // Durable history stays here in GET /api/notifications, so a missed live event is always
        // recoverable.
    }

    public static async Task<IResult> PublishFromAppAsync(
        string appId,
        HttpRequest request,
        AppNotificationCreateRequest? input,
        AppServiceTokenService serviceTokens,
        AppRegistryStore apps,
        NotificationService notifications,
        AuditStore audit,
        IClock clock,
        CancellationToken cancellationToken)
    {
        var token = CoreSessionAuthorization.ReadBearerToken(request);
        if (string.IsNullOrWhiteSpace(token) || !serviceTokens.ValidateToken(appId, token))
        {
            return CoreJson.Json(
                new ErrorResponse("notification_unauthorized", "App service token is missing or invalid."),
                statusCode: StatusCodes.Status401Unauthorized);
        }

        if (await apps.GetAppAsync(appId, cancellationToken) is null)
        {
            return CoreJson.Json(
                new ErrorResponse("app_not_found", "Runtime app was not found."),
                statusCode: StatusCodes.Status404NotFound);
        }

        var (command, errorCode, statusCode) = ValidateAppRequest(input);
        if (command is null)
        {
            return CoreJson.Json(new ErrorResponse(errorCode!, ErrorMessage(errorCode!)), statusCode: statusCode);
        }

        var result = await notifications.PublishAsync(
            new AppScope(appId),
            command.Target,
            NotificationService.AudienceUser,
            command.Level,
            command.Title,
            command.Body,
            command.Link,
            command.DedupeKey,
            cancellationToken);

        if (result.RecipientCount > 0)
        {
            await audit.AppendAsync(
                new AuditRecord(
                    Id: $"audit_{Guid.NewGuid():N}",
                    Action: "notification.publish",
                    ResourceType: "notification",
                    ResourceId: null,
                    Outcome: "succeeded",
                    ActorUserId: null,
                    CreatedAt: clock.UtcNow,
                    Details: new Dictionary<string, string>(StringComparer.Ordinal)
                    {
                        ["appId"] = appId,
                        ["recipients"] = result.RecipientCount.ToString(System.Globalization.CultureInfo.InvariantCulture),
                        ["status"] = result.Status,
                    }),
                cancellationToken);
        }

        return CoreJson.Json(
            result,
            statusCode: string.Equals(result.Status, "created", StringComparison.Ordinal)
                ? StatusCodes.Status201Created
                : StatusCodes.Status200OK);
    }

    // Pure input validation (no IO) so it can be unit-tested directly. Apps may only target the
    // "user" audience; "host-admin" is reserved for the in-process Core producer.
    internal static (ValidatedNotification? Command, string? ErrorCode, int StatusCode) ValidateAppRequest(AppNotificationCreateRequest? input)
    {
        var title = input?.Title?.Trim();
        if (string.IsNullOrWhiteSpace(title))
        {
            return (null, "notification_title_required", StatusCodes.Status400BadRequest);
        }

        if (title.Length > MaxTitleLength)
        {
            return (null, "notification_title_too_long", StatusCodes.Status400BadRequest);
        }

        var body = input?.Body?.Trim();
        if (body is { Length: > MaxBodyLength })
        {
            return (null, "notification_body_too_long", StatusCodes.Status400BadRequest);
        }

        body = string.IsNullOrWhiteSpace(body) ? null : body;

        var audience = string.IsNullOrWhiteSpace(input?.Audience)
            ? NotificationService.AudienceUser
            : input!.Audience!.Trim().ToLowerInvariant();
        if (string.Equals(audience, NotificationService.AudienceHostAdmin, StringComparison.Ordinal))
        {
            return (null, "notification_audience_forbidden", StatusCodes.Status403Forbidden);
        }

        if (!string.Equals(audience, NotificationService.AudienceUser, StringComparison.Ordinal))
        {
            return (null, "notification_audience_invalid", StatusCodes.Status400BadRequest);
        }

        var level = string.IsNullOrWhiteSpace(input?.Level) ? "info" : input!.Level!.Trim().ToLowerInvariant();
        if (!NotificationService.IsValidLevel(level))
        {
            return (null, "notification_level_invalid", StatusCodes.Status400BadRequest);
        }

        var target = input?.Target?.Trim();
        if (string.IsNullOrWhiteSpace(target))
        {
            return (null, "notification_target_required", StatusCodes.Status400BadRequest);
        }

        var link = string.IsNullOrWhiteSpace(input?.Link) ? null : input!.Link!.Trim();
        var dedupeKey = string.IsNullOrWhiteSpace(input?.DedupeKey) ? null : input!.DedupeKey!.Trim();

        return (new ValidatedNotification(target, level, title, body, link, dedupeKey), null, StatusCodes.Status200OK);
    }

    private static string ErrorMessage(string code) => code switch
    {
        "notification_title_required" => "Notification title is required.",
        "notification_title_too_long" => $"Notification title must be at most {MaxTitleLength} characters.",
        "notification_body_too_long" => $"Notification body must be at most {MaxBodyLength} characters.",
        "notification_audience_forbidden" => "Apps cannot send host-admin notifications.",
        "notification_audience_invalid" => "Unsupported notification audience.",
        "notification_level_invalid" => "Unsupported notification level.",
        "notification_target_required" => "Notification target is required.",
        _ => "Invalid notification request.",
    };

    public static Task<IResult> ListForSessionAsync(
        HttpRequest request,
        UserDirectoryStore users,
        IClock clock,
        NotificationService notifications,
        CancellationToken cancellationToken)
        => CoreSessionAuthorization.RequireSessionAsync(
            request,
            users,
            clock,
            async user =>
            {
                var unreadOnly = string.Equals(request.Query["unread"].ToString(), "true", StringComparison.OrdinalIgnoreCase);
                var limit = ParseBoundedInt(request.Query["limit"].ToString(), defaultValue: 50, min: 1, max: 200);
                var offset = ParseBoundedInt(request.Query["offset"].ToString(), defaultValue: 0, min: 0, max: int.MaxValue);
                var response = await notifications.QueryAsync(
                    user.Id,
                    includeHostAdmin: string.Equals(user.Role, NotificationService.HostAdminRole, StringComparison.Ordinal),
                    unreadOnly,
                    limit,
                    offset,
                    cancellationToken);
                return CoreJson.Json(response);
            },
            cancellationToken: cancellationToken);

    public static Task<IResult> MarkReadForSessionAsync(
        HttpRequest request,
        NotificationMarkReadRequest? input,
        UserDirectoryStore users,
        IClock clock,
        NotificationService notifications,
        CancellationToken cancellationToken)
        => CoreSessionAuthorization.RequireSessionAsync(
            request,
            users,
            clock,
            async user =>
            {
                var response = await notifications.MarkReadAsync(user.Id, input?.Ids, cancellationToken);
                return CoreJson.Json(response);
            },
            requireCsrf: true,
            cancellationToken: cancellationToken);

    private static int ParseBoundedInt(string? raw, int defaultValue, int min, int max)
        => int.TryParse(raw, out var value) ? Math.Clamp(value, min, max) : defaultValue;
}

internal sealed record AppNotificationCreateRequest(
    string? Target,
    string? Audience,
    string? Level,
    string? Title,
    string? Body,
    string? Link,
    string? DedupeKey);

internal sealed record ValidatedNotification(
    string Target,
    string Level,
    string Title,
    string? Body,
    string? Link,
    string? DedupeKey);

internal sealed record NotificationMarkReadRequest(IReadOnlyList<string>? Ids);
