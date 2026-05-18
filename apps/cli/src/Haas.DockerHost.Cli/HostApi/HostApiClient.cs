namespace Haas.DockerHost.Cli.HostApi;

using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Haas.DockerHost.Cli;

internal sealed class HostApiClient(HttpClient httpClient, string? bearerToken = null) : IDisposable
{
    public const string ContractVersion = "0.1";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = false,
    };

    public Task<HostApiResponse<HostStatusResponse>> GetHostStatusAsync(CancellationToken cancellationToken = default)
        => SendAsync<HostStatusResponse>("read Host status", HttpMethod.Get, "api/host/status", cancellationToken: cancellationToken);

    public Task<HostApiResponse<CliTokenListResponse>> ListCliTokensAsync(CancellationToken cancellationToken = default)
        => SendAsync<CliTokenListResponse>("list CLI tokens", HttpMethod.Get, "api/auth/cli-tokens", cancellationToken: cancellationToken);

    public Task<HostApiResponse<CliTokenCreateResponse>> CreateCliTokenAsync(
        CliTokenCreateRequest request,
        CancellationToken cancellationToken = default)
        => SendAsync<CliTokenCreateResponse>(
            "create CLI token",
            HttpMethod.Post,
            "api/auth/cli-tokens",
            request,
            cancellationToken);

    public Task<HostApiResponse<CliTokenCreateResponse>> RotateCliTokenAsync(
        string tokenId,
        CliTokenRotateRequest request,
        CancellationToken cancellationToken = default)
        => SendAsync<CliTokenCreateResponse>(
            "rotate CLI token",
            HttpMethod.Post,
            $"api/auth/cli-tokens/{Uri.EscapeDataString(tokenId)}/rotate",
            request,
            cancellationToken);

    public Task<HostApiResponse<CliTokenRevokeResponse>> RevokeCliTokenAsync(
        string tokenId,
        CancellationToken cancellationToken = default)
        => SendAsync<CliTokenRevokeResponse>(
            "revoke CLI token",
            HttpMethod.Delete,
            $"api/auth/cli-tokens/{Uri.EscapeDataString(tokenId)}",
            cancellationToken: cancellationToken);

    public Task<HostApiResponse<ModuleListResponse>> ListModulesAsync(CancellationToken cancellationToken = default)
        => SendAsync<ModuleListResponse>("list modules", HttpMethod.Get, "api/modules", cancellationToken: cancellationToken);

    public Task<HostApiResponse<ModuleActionResult>> RunModuleActionAsync(
        string moduleId,
        string action,
        CancellationToken cancellationToken = default)
        => SendAsync<ModuleActionResult>(
            $"{action} module",
            HttpMethod.Post,
            $"api/modules/{Uri.EscapeDataString(moduleId)}/{action}",
            cancellationToken: cancellationToken);

    public Task<HostApiResponse<InstallPlanResponse>> CreateInstallPlanAsync(
        string metadataUrl,
        CancellationToken cancellationToken = default)
        => SendAsync<InstallPlanResponse>(
            "create module install plan",
            HttpMethod.Post,
            "api/modules/install/plan",
            new { metadataUrl },
            cancellationToken);

    public Task<HostApiResponse<ModuleInstallResponse>> ApplyInstallAsync(
        ModuleInstallRequest request,
        CancellationToken cancellationToken = default)
        => SendAsync<ModuleInstallResponse>(
            "apply module install",
            HttpMethod.Post,
            "api/modules/install",
            request,
            cancellationToken);

    public Task<HostApiResponse<ModuleUpdatePlanResponse>> CreateUpdatePlanAsync(
        string moduleId,
        CancellationToken cancellationToken = default)
        => SendAsync<ModuleUpdatePlanResponse>(
            "create module update plan",
            HttpMethod.Post,
            $"api/modules/{Uri.EscapeDataString(moduleId)}/update/plan",
            cancellationToken: cancellationToken);

    public Task<HostApiResponse<ModuleUpdateResponse>> ApplyUpdateAsync(
        string moduleId,
        ModuleUpdateRequest request,
        CancellationToken cancellationToken = default)
        => SendAsync<ModuleUpdateResponse>(
            "apply module update",
            HttpMethod.Post,
            $"api/modules/{Uri.EscapeDataString(moduleId)}/update",
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
        request.Headers.TryAddWithoutValidation("X-Docker-Host-Api-Contract-Version", ContractVersion);
        if (!string.IsNullOrWhiteSpace(bearerToken))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearerToken);
        }

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
                "Unable to reach the Docker Host API.",
                responseBody: ex.Message,
                nextStep: "Run 'docker-host status' and confirm that the Host container is running.",
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
                    "Docker Host API returned a response that docker-host could not parse.",
                    response.StatusCode,
                    rawBody,
                    "Update docker-host and the Host image, then retry.",
                    ex);
            }
        }

        return new HostApiResponse<T>(response.StatusCode, parsedBody, rawBody);
    }
}
