namespace Haas.DockerHost.Cli.HostApi;

using System.Net.Http;
using System.Text;
using System.Text.Json;
using Haas.DockerHost.Cli;

internal sealed class HostControlClient(HttpClient httpClient, string controlSecret) : IDisposable
{
    public const string ContractVersion = "0.1";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = false,
    };

    public Task<HostApiResponse<HostStatusResponse>> GetHostStatusAsync(CancellationToken cancellationToken = default)
        => SendAsync<HostStatusResponse>("read Host status", HttpMethod.Get, "host/status", cancellationToken: cancellationToken);

    public Task<HostApiResponse<ModuleListResponse>> ListModulesAsync(CancellationToken cancellationToken = default)
        => SendAsync<ModuleListResponse>("list modules", HttpMethod.Get, "modules", cancellationToken: cancellationToken);

    public Task<HostApiResponse<HostUsersResponse>> ListHostUsersAsync(CancellationToken cancellationToken = default)
        => SendAsync<HostUsersResponse>("list Host users", HttpMethod.Get, "auth/users", cancellationToken: cancellationToken);

    public Task<HostApiResponse<UserInvitationCreateResponse>> CreateUserInvitationAsync(
        UserInvitationCreateRequest request,
        CancellationToken cancellationToken = default)
        => SendAsync<UserInvitationCreateResponse>(
            "create Host user invitation",
            HttpMethod.Post,
            "auth/invitations",
            request,
            cancellationToken);

    public Task<HostApiResponse<UserInvitationAcceptResponse>> AcceptUserInvitationAsync(
        UserInvitationAcceptRequest request,
        CancellationToken cancellationToken = default)
        => SendAsync<UserInvitationAcceptResponse>(
            "accept Host user invitation",
            HttpMethod.Post,
            "auth/invitations/accept",
            request,
            cancellationToken);

    public Task<HostApiResponse<UserInvitationRevokeResponse>> RevokeUserInvitationAsync(
        string invitationId,
        CancellationToken cancellationToken = default)
        => SendAsync<UserInvitationRevokeResponse>(
            "revoke Host user invitation",
            HttpMethod.Delete,
            $"auth/invitations/{Uri.EscapeDataString(invitationId)}",
            cancellationToken: cancellationToken);

    public Task<HostApiResponse<HostUserUpdateResponse>> UpdateHostUserAsync(
        string userId,
        HostUserUpdateRequest request,
        CancellationToken cancellationToken = default)
        => SendAsync<HostUserUpdateResponse>(
            "update Host user",
            HttpMethod.Patch,
            $"auth/users/{Uri.EscapeDataString(userId)}",
            request,
            cancellationToken);

    public Task<HostApiResponse<HostUserAssignmentsResponse>> ReplaceHostUserAssignmentsAsync(
        string userId,
        HostUserAssignmentsRequest request,
        CancellationToken cancellationToken = default)
        => SendAsync<HostUserAssignmentsResponse>(
            "replace Host user module assignments",
            HttpMethod.Put,
            $"auth/users/{Uri.EscapeDataString(userId)}/assignments",
            request,
            cancellationToken);

    public Task<HostApiResponse<ModuleDirectoryPolicyResponse>> SetModuleDirectoryPolicyAsync(
        string moduleId,
        ModuleDirectoryPolicyRequest request,
        CancellationToken cancellationToken = default)
        => SendAsync<ModuleDirectoryPolicyResponse>(
            "set module directory policy",
            HttpMethod.Put,
            $"modules/{Uri.EscapeDataString(moduleId)}/directory/policy",
            request,
            cancellationToken);

    public Task<HostApiResponse<HostAppsResponse>> ListAppsAsync(CancellationToken cancellationToken = default)
        => SendAsync<HostAppsResponse>("list Host apps", HttpMethod.Get, "apps", cancellationToken: cancellationToken);

    public Task<HostApiResponse<AppBackupsResponse>> ListAppBackupsAsync(
        string appId,
        CancellationToken cancellationToken = default)
        => SendAsync<AppBackupsResponse>(
            "list app backups",
            HttpMethod.Get,
            $"apps/{Uri.EscapeDataString(appId)}/backups",
            cancellationToken: cancellationToken);

    public Task<HostApiResponse<AppBackupResponse>> CreateAppBackupAsync(
        string appId,
        CancellationToken cancellationToken = default)
        => SendAsync<AppBackupResponse>(
            "create app backup",
            HttpMethod.Post,
            $"apps/{Uri.EscapeDataString(appId)}/backups",
            cancellationToken: cancellationToken);

    public Task<HostApiResponse<AppRestoreResponse>> RestoreAppBackupAsync(
        string appId,
        string backupId,
        AppRestoreRequest request,
        CancellationToken cancellationToken = default)
        => SendAsync<AppRestoreResponse>(
            "restore app backup",
            HttpMethod.Post,
            $"apps/{Uri.EscapeDataString(appId)}/backups/{Uri.EscapeDataString(backupId)}/restore",
            request,
            cancellationToken);

    public Task<HostApiResponse<ModuleActionResult>> RunModuleActionAsync(
        string moduleId,
        string action,
        CancellationToken cancellationToken = default)
        => SendAsync<ModuleActionResult>(
            $"{action} module",
            HttpMethod.Post,
            $"modules/{Uri.EscapeDataString(moduleId)}/{action}",
            cancellationToken: cancellationToken);

    public Task<HostApiResponse<InstallPlanResponse>> CreateInstallPlanAsync(
        string metadataUrl,
        CancellationToken cancellationToken = default)
        => SendAsync<InstallPlanResponse>(
            "create module install plan",
            HttpMethod.Post,
            "modules/install/plan",
            new { manifestUrl = metadataUrl, metadataUrl },
            cancellationToken);

    public Task<HostApiResponse<ModuleInstallResponse>> ApplyInstallAsync(
        ModuleInstallRequest request,
        CancellationToken cancellationToken = default)
        => SendAsync<ModuleInstallResponse>(
            "apply module install",
            HttpMethod.Post,
            "modules/install",
            request,
            cancellationToken);

    public Task<HostApiResponse<ModuleUpdatePlanResponse>> CreateUpdatePlanAsync(
        string moduleId,
        CancellationToken cancellationToken = default)
        => SendAsync<ModuleUpdatePlanResponse>(
            "create module update plan",
            HttpMethod.Post,
            $"modules/{Uri.EscapeDataString(moduleId)}/update/plan",
            cancellationToken: cancellationToken);

    public Task<HostApiResponse<ModuleUpdateResponse>> ApplyUpdateAsync(
        string moduleId,
        ModuleUpdateRequest request,
        CancellationToken cancellationToken = default)
        => SendAsync<ModuleUpdateResponse>(
            "apply module update",
            HttpMethod.Post,
            $"modules/{Uri.EscapeDataString(moduleId)}/update",
            request,
            cancellationToken);

    public Task<HostApiResponse<ModuleRemovePlanResponse>> CreateRemovePlanAsync(
        string moduleId,
        ModuleRemovePlanRequest request,
        CancellationToken cancellationToken = default)
        => SendAsync<ModuleRemovePlanResponse>(
            "create module remove plan",
            HttpMethod.Post,
            $"modules/{Uri.EscapeDataString(moduleId)}/remove/plan",
            request,
            cancellationToken);

    public Task<HostApiResponse<ModuleActionResult>> ApplyRemoveAsync(
        string moduleId,
        ModuleRemoveRequest request,
        CancellationToken cancellationToken = default)
        => SendAsync<ModuleActionResult>(
            "remove module",
            HttpMethod.Post,
            $"modules/{Uri.EscapeDataString(moduleId)}/remove",
            request,
            cancellationToken);

    public void Dispose() => httpClient.Dispose();

    private async Task<HostApiResponse<T>> SendAsync<T>(
        string operation,
        HttpMethod method,
        string path,
        object? body = null,
        CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.TryAddWithoutValidation("X-Docker-Host-Cli-Version", CommandLine.Version);
        request.Headers.TryAddWithoutValidation("X-Docker-Host-Control-Contract-Version", ContractVersion);
        request.Headers.TryAddWithoutValidation("X-Docker-Host-Control-Secret", controlSecret);

        if (body is not null)
        {
            request.Content = new StringContent(JsonSerializer.Serialize(body, JsonOptions), Encoding.UTF8, "application/json");
        }

        HttpResponseMessage response;
        try
        {
            response = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TimeoutException)
        {
            throw new HostApiException(
                operation,
                "Unable to reach the Host trusted control channel.",
                responseBody: ex.Message,
                nextStep: "Run 'hosty start' first, or restart the Host so it can publish run/control.json.",
                innerException: ex);
        }

        using var _ = response;
        var rawBody = await response.Content.ReadAsStringAsync(cancellationToken);
        T? parsedBody = default;
        if (!string.IsNullOrWhiteSpace(rawBody))
        {
            try
            {
                parsedBody = JsonSerializer.Deserialize<T>(rawBody, JsonOptions);
            }
            catch (JsonException ex)
            {
                throw new HostApiException(
                    operation,
                    "Host control returned a response that hosty could not parse.",
                    response.StatusCode,
                    rawBody,
                    "Update hosty, restart the Host with 'hosty stop' and 'hosty start', then retry.",
                    ex);
            }
        }

        return new HostApiResponse<T>(response.StatusCode, parsedBody, rawBody);
    }
}
