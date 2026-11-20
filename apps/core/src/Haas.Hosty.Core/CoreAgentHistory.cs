using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreAgentHistoryRequest(HostyProviderRef Provider);
internal sealed record CoreAgentHistoryIntrospection(string Token, string Key);
internal sealed record CoreAgentHistoryBinding(string Token, DateTimeOffset ExpiresAt, string Endpoint);
internal sealed record CoreAgentHistoryInvocation(string CallerAppId, string CallerInstallation, HostyProviderRef Provider,
    DateTimeOffset ExpiresAt);
internal sealed record CoreAgentHistoryToken(string CallerAppId, DateTimeOffset CallerInstallation, string? CallerRevision,
    HostyProviderRef Provider, string? ProviderRevision, DateTimeOffset ExpiresAt);

internal sealed partial class CoreAgentExecution
{
    private const string HistoryPrefix = "hosty_agent_history.1.";

    internal async Task<CoreAgentHistoryBinding> AuthorizeHistory(AppRecord consumer, CoreAgentHistoryRequest input, CancellationToken ct)
    {
        CoreProviderMediation.ValidateReference(input.Provider);
        RequireHistoryPermission(consumer);
        var provider = await apps.GetAppAsync(input.Provider.AppId, ct)
            ?? throw new CoreProviderException("provider_unavailable", "The selected provider is unavailable.", 503);
        var descriptor = Descriptor(provider, input.Provider);
        var expiresAt = clock.UtcNow.AddHours(4);
        var claims = new CoreAgentHistoryToken(consumer.Id, consumer.InstalledAt, consumer.PermissionRevision,
            input.Provider, provider.PermissionRevision, expiresAt);
        return new(SignToken(HistoryPrefix, claims), expiresAt, descriptor.Url!);
    }

    internal async Task<CoreAgentHistoryInvocation> IntrospectHistory(AppRecord provider, CoreAgentHistoryIntrospection input, CancellationToken ct)
    {
        var token = ReadToken<CoreAgentHistoryToken>(HistoryPrefix, input.Token);
        if (token.ExpiresAt <= clock.UtcNow || token.Provider.AppId != provider.Id || token.Provider.Key != input.Key ||
            token.Provider.InstallationId != PanelIdentity.Installation(provider) || token.ProviderRevision != provider.PermissionRevision)
            throw new AppIdentityException("token_invalid", "The history credential expired or its provider binding changed.");
        _ = Descriptor(provider, token.Provider);
        var consumer = await apps.GetAppAsync(token.CallerAppId, ct);
        if (consumer is null || consumer.InstalledAt != token.CallerInstallation || consumer.PermissionRevision != token.CallerRevision)
            throw new AppIdentityException("permission_denied", "The consuming installation or its reviewed grants changed.");
        RequireHistoryPermission(consumer);
        return new(consumer.Id, consumer.InstalledAt.ToString("O"), token.Provider, token.ExpiresAt);
    }

    private static void RequireHistoryPermission(AppRecord consumer)
    {
        if (!AppManagementAuthorization.HasPermission(consumer, CoreAppPermissions.AgentProviders))
            throw new AppIdentityException("app_permission_required", "History delivery requires providers.agent.");
    }
}
