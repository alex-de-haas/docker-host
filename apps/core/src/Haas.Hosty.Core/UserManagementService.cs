using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

internal sealed class UserManagementService(
    UserDirectoryStore users,
    AppRegistryStore apps,
    AuditStore audit,
    HostyCoreRuntimeConfig config,
    IClock clock)
{
    private const long InviteMinTtlMs = 15 * 60 * 1000;
    private const long InviteDefaultTtlMs = 24 * 60 * 60 * 1000;
    private const long InviteMaxTtlMs = 7 * 24 * 60 * 60 * 1000;

    public async Task<UserManagementStateResponse> ListAsync(CancellationToken cancellationToken = default)
    {
        var state = await users.ReadAsync(cancellationToken);
        var now = clock.UtcNow;
        var appSummaries = (await apps.ListAppsAsync(cancellationToken))
            .Where(app => !app.System)
            .OrderBy(app => app.DisplayName, StringComparer.OrdinalIgnoreCase)
            .Select(app => new AssignableAppSummary(app.Id, app.DisplayName, app.Version, app.OperationStatus))
            .ToArray();

        return new UserManagementStateResponse(
            Users: state.Users
                .OrderBy(user => user.Email ?? user.Id, StringComparer.OrdinalIgnoreCase)
                .Select(user => SummarizeUser(state, user, now))
                .ToArray(),
            Invitations: state.Invitations
                .OrderByDescending(invitation => invitation.CreatedAt)
                .Select(invitation => SummarizeInvitation(invitation, now))
                .ToArray(),
            Apps: appSummaries,
            Modules: appSummaries,
            InviteTtlOptions:
            [
                new InviteTtlOption("15 minutes", InviteMinTtlMs),
                new InviteTtlOption("24 hours", InviteDefaultTtlMs),
                new InviteTtlOption("7 days", InviteMaxTtlMs),
            ]);
    }

    public async Task<UserInvitationCreateResponse> CreateInvitationAsync(
        UserInvitationCreateRequest request,
        HostUserRecord actor,
        CancellationToken cancellationToken = default)
    {
        var email = NormalizeEmail(request.Email);
        if (string.IsNullOrWhiteSpace(email))
        {
            throw new UserManagementException("invalid_email", "Enter a valid email address.", StatusCodes.Status400BadRequest);
        }

        var role = NormalizeRole(request.Role);
        var ttl = NormalizeInviteTtl(request.TtlMs);
        var now = clock.UtcNow;
        var state = await users.ReadAsync(cancellationToken);
        if (state.Users.Any(user => string.Equals(user.Email, email, StringComparison.OrdinalIgnoreCase)))
        {
            throw new UserManagementException("email_exists", "A Host user with this email already exists.", StatusCodes.Status409Conflict);
        }

        if (state.Invitations.Any(invitation =>
            string.Equals(invitation.Email, email, StringComparison.OrdinalIgnoreCase) &&
            GetInvitationStatus(invitation, now) == "pending"))
        {
            throw new UserManagementException("invitation_exists", "An active invitation for this email already exists.", StatusCodes.Status409Conflict);
        }

        var token = $"dhstp_{Base64UrlEncode(RandomNumberGenerator.GetBytes(32))}";
        var invitation = new HostInvitationRecord(
            Id: $"invite_{Guid.NewGuid():N}",
            Email: email,
            Role: role,
            Status: "pending",
            ExpiresAt: now.AddMilliseconds(ttl),
            CreatedAt: now,
            DisplayName: NormalizeOptional(request.DisplayName),
            AssignedAppIds: role == "host.admin" ? [] : NormalizeIds(request.AssignedModuleIds ?? request.AssignedAppIds ?? []),
            TokenHash: HashToken(token),
            CreatedByUserId: actor.Id);

        await users.WriteAsync(state with { Invitations = state.Invitations.Append(invitation).ToArray() }, cancellationToken);
        await AppendAuditAsync("auth.invitation.created", "auth.invitation", invitation.Id, actor.Id, "succeeded", new Dictionary<string, string>
        {
            ["email"] = email,
            ["role"] = role,
            ["expiresAt"] = invitation.ExpiresAt.ToString("O"),
        }, cancellationToken);

        var setupUrl = $"{ResolveCoreOrigin().TrimEnd('/')}/setup/invite?setupToken={Uri.EscapeDataString(token)}";
        return new UserInvitationCreateResponse(SummarizeInvitation(invitation, now), token, setupUrl);
    }

    public async Task<UserInvitationPreview> PreviewInvitationAsync(string setupToken, CancellationToken cancellationToken = default)
    {
        var state = await users.ReadAsync(cancellationToken);
        var invitation = FindValidInvitation(state, setupToken, clock.UtcNow) ??
            throw new UserManagementException("invitation_invalid", "Invitation token is invalid or expired.", StatusCodes.Status404NotFound);
        return new UserInvitationPreview(
            invitation.Email,
            invitation.DisplayName,
            invitation.Role,
            invitation.AssignedAppIds ?? [],
            invitation.ExpiresAt);
    }

    public async Task<UserManagementHostUserSummary> AcceptInvitationAsync(
        UserInvitationAcceptRequest request,
        CancellationToken cancellationToken = default)
    {
        var now = clock.UtcNow;
        var state = await users.ReadAsync(cancellationToken);
        var invitation = FindValidInvitation(state, request.SetupToken, now) ??
            throw new UserManagementException("invitation_invalid", "Invitation token is invalid or expired.", StatusCodes.Status404NotFound);
        if (state.Users.Any(user => string.Equals(user.Email, invitation.Email, StringComparison.OrdinalIgnoreCase)))
        {
            throw new UserManagementException("email_exists", "A Host user with this email already exists.", StatusCodes.Status409Conflict);
        }

        var user = new HostUserRecord(
            Id: $"user_{Guid.NewGuid():N}",
            Email: invitation.Email,
            DisplayName: NormalizeOptional(request.DisplayName) ?? invitation.DisplayName ?? invitation.Email,
            Role: invitation.Role,
            Disabled: false,
            CreatedAt: now,
            UpdatedAt: now);
        var assignmentIds = invitation.Role == "host.admin" ? [] : invitation.AssignedAppIds ?? [];
        var assignments = assignmentIds
            .Select(appId => new AppAssignmentRecord(appId, user.Id, now))
            .ToArray();
        var invitations = state.Invitations
            .Select(candidate => string.Equals(candidate.Id, invitation.Id, StringComparison.Ordinal)
                ? candidate with { Status = "used", UsedAt = now }
                : candidate)
            .ToArray();

        var nextState = state with
        {
            Users = state.Users.Append(user).ToArray(),
            Invitations = invitations,
            Assignments = state.Assignments.Concat(assignments).ToArray(),
        };
        await users.WriteAsync(nextState, cancellationToken);
        await AppendAuditAsync("auth.invitation.accepted", "auth.user", user.Id, user.Id, "succeeded", new Dictionary<string, string>
        {
            ["invitationId"] = invitation.Id,
            ["email"] = invitation.Email,
            ["role"] = invitation.Role,
        }, cancellationToken);

        return SummarizeUser(nextState, user, now);
    }

    public async Task<UserInvitationRevokeResponse> RevokeInvitationAsync(
        string invitationId,
        HostUserRecord actor,
        CancellationToken cancellationToken = default)
    {
        var now = clock.UtcNow;
        var state = await users.ReadAsync(cancellationToken);
        var found = false;
        var invitations = state.Invitations
            .Select(invitation =>
            {
                if (!string.Equals(invitation.Id, invitationId, StringComparison.Ordinal))
                {
                    return invitation;
                }

                found = true;
                return invitation with { Status = "revoked", RevokedAt = now };
            })
            .ToArray();
        if (!found)
        {
            throw new UserManagementException("invitation_not_found", "Invitation was not found.", StatusCodes.Status404NotFound);
        }

        await users.WriteAsync(state with { Invitations = invitations }, cancellationToken);
        await AppendAuditAsync(
            "auth.invitation.revoked",
            "auth.invitation",
            invitationId,
            actor.Id,
            "succeeded",
            new Dictionary<string, string>(),
            cancellationToken);
        return new UserInvitationRevokeResponse(true);
    }

    public async Task<HostUserUpdateResponse> UpdateUserAsync(
        string userId,
        HostUserUpdateRequest request,
        HostUserRecord actor,
        CancellationToken cancellationToken = default)
    {
        var now = clock.UtcNow;
        var state = await users.ReadAsync(cancellationToken);
        var user = state.Users.FirstOrDefault(candidate => string.Equals(candidate.Id, userId, StringComparison.Ordinal) && !candidate.Disabled) ??
            throw new UserManagementException("user_not_found", "The Host user is disabled or does not exist.", StatusCodes.Status404NotFound);
        var nextRole = string.IsNullOrWhiteSpace(request.Role) ? user.Role : NormalizeRole(request.Role);
        if (user.Role == "host.admin" && nextRole != "host.admin" && CountActiveAdmins(state.Users) <= 1)
        {
            throw new UserManagementException("last_admin", "At least one active Host administrator must remain.", StatusCodes.Status409Conflict);
        }

        if (string.Equals(user.Id, actor.Id, StringComparison.Ordinal) &&
            user.Role == "host.admin" &&
            nextRole != "host.admin")
        {
            throw new UserManagementException("self_role_change_forbidden", "Administrators cannot change their own role to user.", StatusCodes.Status409Conflict);
        }

        var updated = user with
        {
            DisplayName = request.DisplayName is null ? user.DisplayName : NormalizeOptional(request.DisplayName),
            Role = nextRole,
            UpdatedAt = now,
        };
        var roleChanged = !string.Equals(user.Role, updated.Role, StringComparison.Ordinal);
        var sessions = roleChanged ? RevokeSessions(state.Sessions, user.Id, now, out _) : state.Sessions;
        var nextState = state with
        {
            Users = state.Users.Select(candidate => string.Equals(candidate.Id, user.Id, StringComparison.Ordinal) ? updated : candidate).ToArray(),
            Sessions = sessions,
        };
        await users.WriteAsync(nextState, cancellationToken);
        await AppendAuditAsync("auth.user.updated", "auth.user", user.Id, actor.Id, "succeeded", new Dictionary<string, string>
        {
            ["role"] = updated.Role,
            ["roleChanged"] = roleChanged.ToString(System.Globalization.CultureInfo.InvariantCulture),
        }, cancellationToken);

        return new HostUserUpdateResponse(SummarizeUser(nextState, updated, now));
    }

    public async Task<HostUserDisableResponse> DisableUserAsync(
        string userId,
        HostUserRecord actor,
        CancellationToken cancellationToken = default)
    {
        if (string.Equals(userId, actor.Id, StringComparison.Ordinal))
        {
            throw new UserManagementException("self_disable_forbidden", "Administrators cannot disable their own account.", StatusCodes.Status409Conflict);
        }

        var now = clock.UtcNow;
        var state = await users.ReadAsync(cancellationToken);
        var user = state.Users.FirstOrDefault(candidate => string.Equals(candidate.Id, userId, StringComparison.Ordinal) && !candidate.Disabled) ??
            throw new UserManagementException("user_not_found", "The Host user is disabled or does not exist.", StatusCodes.Status404NotFound);
        if (user.Role == "host.admin" && CountActiveAdmins(state.Users) <= 1)
        {
            throw new UserManagementException("last_admin", "At least one active Host administrator must remain.", StatusCodes.Status409Conflict);
        }

        var disabled = user with { Disabled = true, UpdatedAt = now };
        var sessions = RevokeSessions(state.Sessions, user.Id, now, out var revokedSessionCount);
        var assignments = state.Assignments.Where(assignment => !string.Equals(assignment.UserId, user.Id, StringComparison.Ordinal)).ToArray();
        var nextState = state with
        {
            Users = state.Users.Select(candidate => string.Equals(candidate.Id, user.Id, StringComparison.Ordinal) ? disabled : candidate).ToArray(),
            Sessions = sessions,
            Assignments = assignments,
        };
        await users.WriteAsync(nextState, cancellationToken);
        await AppendAuditAsync("auth.user.disabled", "auth.user", user.Id, actor.Id, "succeeded", new Dictionary<string, string>
        {
            ["revokedSessionCount"] = revokedSessionCount.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["removedAssignmentCount"] = (state.Assignments.Count - assignments.Length).ToString(System.Globalization.CultureInfo.InvariantCulture),
        }, cancellationToken);

        return new HostUserDisableResponse(SummarizeUser(nextState, disabled, now), true);
    }

    public async Task<HostUserAssignmentsResponse> ReplaceAssignmentsAsync(
        string userId,
        HostUserAssignmentsRequest request,
        HostUserRecord actor,
        CancellationToken cancellationToken = default)
    {
        var now = clock.UtcNow;
        var state = await users.ReadAsync(cancellationToken);
        var user = state.Users.FirstOrDefault(candidate => string.Equals(candidate.Id, userId, StringComparison.Ordinal) && !candidate.Disabled) ??
            throw new UserManagementException("user_not_found", "The Host user is disabled or does not exist.", StatusCodes.Status404NotFound);
        var assignedAppIds = user.Role == "host.admin" ? [] : NormalizeIds(request.AssignedModuleIds ?? request.AssignedAppIds ?? []);
        var assignments = state.Assignments
            .Where(assignment => !string.Equals(assignment.UserId, user.Id, StringComparison.Ordinal))
            .Concat(assignedAppIds.Select(appId => new AppAssignmentRecord(appId, user.Id, now)))
            .ToArray();

        await users.WriteAsync(state with { Assignments = assignments }, cancellationToken);
        await AppendAuditAsync("auth.user.assignments.updated", "auth.user", user.Id, actor.Id, "succeeded", new Dictionary<string, string>
        {
            ["assignedAppIds"] = string.Join(",", assignedAppIds),
        }, cancellationToken);

        return new HostUserAssignmentsResponse(assignments.Where(assignment => string.Equals(assignment.UserId, user.Id, StringComparison.Ordinal)).ToArray());
    }

    private static UserManagementHostUserSummary SummarizeUser(UserDirectoryState state, HostUserRecord user, DateTimeOffset now)
    {
        var activeSessions = state.Sessions
            .Where(session =>
                string.Equals(session.UserId, user.Id, StringComparison.Ordinal) &&
                session.RevokedAt is null &&
                session.ExpiresAt > now)
            .ToArray();
        return new UserManagementHostUserSummary(
            user.Id,
            user.Email,
            user.DisplayName,
            user.Role,
            "local",
            user.Disabled,
            user.CreatedAt,
            user.UpdatedAt,
            activeSessions.Length,
            state.Assignments
                .Where(assignment => string.Equals(assignment.UserId, user.Id, StringComparison.Ordinal))
                .Select(assignment => assignment.AppId)
                .Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal)
                .ToArray(),
            activeSessions.OrderByDescending(session => session.CreatedAt).FirstOrDefault()?.CreatedAt);
    }

    private static UserInvitationSummary SummarizeInvitation(HostInvitationRecord invitation, DateTimeOffset now)
        => new(
            invitation.Id,
            invitation.Email,
            invitation.DisplayName,
            invitation.Role,
            invitation.AssignedAppIds ?? [],
            invitation.CreatedByUserId,
            invitation.CreatedAt,
            invitation.ExpiresAt,
            invitation.UsedAt,
            invitation.RevokedAt,
            GetInvitationStatus(invitation, now));

    private static string GetInvitationStatus(HostInvitationRecord invitation, DateTimeOffset now)
    {
        if (invitation.RevokedAt is not null || invitation.Status == "revoked")
        {
            return "revoked";
        }

        if (invitation.UsedAt is not null || invitation.Status == "used")
        {
            return "used";
        }

        return invitation.ExpiresAt <= now ? "expired" : "pending";
    }

    private HostInvitationRecord? FindValidInvitation(UserDirectoryState state, string token, DateTimeOffset now)
    {
        var hash = HashToken(token);
        return state.Invitations.FirstOrDefault(invitation =>
            !string.IsNullOrWhiteSpace(invitation.TokenHash) &&
            string.Equals(invitation.TokenHash, hash, StringComparison.Ordinal) &&
            GetInvitationStatus(invitation, now) == "pending");
    }

    private async Task AppendAuditAsync(
        string action,
        string resourceType,
        string? resourceId,
        string? actorUserId,
        string outcome,
        IReadOnlyDictionary<string, string> details,
        CancellationToken cancellationToken)
        => await audit.AppendAsync(new AuditRecord(
            Id: $"audit_{Guid.NewGuid():N}",
            Action: action,
            ResourceType: resourceType,
            ResourceId: resourceId,
            Outcome: outcome,
            ActorUserId: actorUserId,
            CreatedAt: clock.UtcNow,
            Details: details), cancellationToken);

    private string ResolveCoreOrigin()
        => config.CorePublicOrigin ?? config.ListenUrl;

    private static IReadOnlyList<AuthSessionRecord> RevokeSessions(
        IReadOnlyList<AuthSessionRecord> sessions,
        string userId,
        DateTimeOffset now,
        out int revokedCount)
    {
        revokedCount = 0;
        var next = new List<AuthSessionRecord>();
        foreach (var session in sessions)
        {
            if (string.Equals(session.UserId, userId, StringComparison.Ordinal) &&
                session.RevokedAt is null &&
                session.ExpiresAt > now)
            {
                revokedCount++;
                next.Add(session with { RevokedAt = now });
            }
            else
            {
                next.Add(session);
            }
        }

        return next;
    }

    private static string NormalizeRole(string? role)
        => role is "host.admin" or "host.user"
            ? role
            : throw new UserManagementException("invalid_role", "Host role must be host.admin or host.user.", StatusCodes.Status400BadRequest);

    private static string NormalizeEmail(string? value)
    {
        var email = NormalizeOptional(value)?.ToLowerInvariant();
        return email is not null && email.Contains('@', StringComparison.Ordinal) ? email : "";
    }

    private static string? NormalizeOptional(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static IReadOnlyList<string> NormalizeIds(IReadOnlyList<string> ids)
        => ids
            .Select(id => id.Trim())
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();

    private static long NormalizeInviteTtl(long? ttlMs)
        => Math.Clamp(ttlMs ?? InviteDefaultTtlMs, InviteMinTtlMs, InviteMaxTtlMs);

    private static int CountActiveAdmins(IReadOnlyList<HostUserRecord> users)
        => users.Count(user => user.Role == "host.admin" && !user.Disabled);

    private static string HashToken(string token)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

    private static string Base64UrlEncode(byte[] bytes)
        => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

internal sealed record UserManagementStateResponse(
    IReadOnlyList<UserManagementHostUserSummary> Users,
    IReadOnlyList<UserInvitationSummary> Invitations,
    IReadOnlyList<AssignableAppSummary> Apps,
    IReadOnlyList<AssignableAppSummary> Modules,
    IReadOnlyList<InviteTtlOption> InviteTtlOptions);

internal sealed record UserManagementHostUserSummary(
    string Id,
    string? Email,
    string? DisplayName,
    string Role,
    string AuthProvider,
    bool Disabled,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    int ActiveSessionCount,
    IReadOnlyList<string> AssignedModuleIds,
    DateTimeOffset? LastSeenAt);

internal sealed record UserInvitationSummary(
    string Id,
    string Email,
    string? DisplayName,
    string Role,
    IReadOnlyList<string> AssignedModuleIds,
    string? CreatedByUserId,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? UsedAt,
    DateTimeOffset? RevokedAt,
    string Status);

internal sealed record AssignableAppSummary(string Id, string Name, string Version, string OperationStatus);

internal sealed record InviteTtlOption(string Label, long TtlMs);

internal sealed record UserInvitationCreateRequest(
    string Email,
    string? DisplayName = null,
    string Role = "host.user",
    long? TtlMs = null,
    IReadOnlyList<string>? AssignedModuleIds = null,
    IReadOnlyList<string>? AssignedAppIds = null);

internal sealed record UserInvitationCreateResponse(UserInvitationSummary Invitation, string Token, string SetupUrl);

internal sealed record UserInvitationPreview(
    string Email,
    string? DisplayName,
    string Role,
    IReadOnlyList<string> AssignedModuleIds,
    DateTimeOffset ExpiresAt);

internal sealed record UserInvitationAcceptRequest(string SetupToken, string? DisplayName = null, string? Password = null);

internal sealed record UserInvitationAcceptResponse(UserManagementHostUserSummary User, string RedirectTo);

internal sealed record UserInvitationRevokeResponse(bool Revoked);

internal sealed record HostUserUpdateRequest(string? DisplayName = null, string? Role = null);

internal sealed record HostUserUpdateResponse(UserManagementHostUserSummary User);

internal sealed record HostUserDisableResponse(UserManagementHostUserSummary User, bool Disabled);

internal sealed record HostUserAssignmentsRequest(
    IReadOnlyList<string>? AssignedModuleIds = null,
    IReadOnlyList<string>? AssignedAppIds = null);

internal sealed record HostUserAssignmentsResponse(IReadOnlyList<AppAssignmentRecord> Assignments);

internal sealed class UserManagementException(string code, string message, int statusCode) : Exception(message)
{
    public string Code { get; } = code;

    public int StatusCode { get; } = statusCode;
}
