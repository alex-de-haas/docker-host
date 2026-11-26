using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreAgentCleanupRequest(string? AdmissionRef, HostyProviderRef Provider, string Operation,
    string Method, string Path, string BodyHash, string? SessionId = null, string? RunId = null, string? ActorUserId = null);
internal sealed record CoreAgentCleanupToken(string AdmissionRef, string Operation, string Method, string Path,
    string BodyHash, long Expires);

internal sealed partial class CoreAgentExecution
{
    private const string CleanupPrefix = "hosty_agent_cleanup.2.";

    internal async Task<CoreAgentBinding> AuthorizeReplay(AppRecord consumer, CoreAgentCleanupRequest input, CancellationToken ct)
    {
        var reference = input.AdmissionRef;
        if (reference is null) {
            if (input.Operation != "runs.start" || string.IsNullOrEmpty(input.ActorUserId)
                || !Guid.TryParse(input.SessionId, out _) || !Guid.TryParse(input.RunId, out _)) throw DenyCleanup();
            reference = OriginalStartId(consumer, input.ActorUserId, CoreCapabilityAuthorization.AppPrincipal(consumer),
                input.Provider, input.SessionId!, input.RunId!);
        }
        CoreAgentAuthorization receipt;
        try { receipt = await store.Get(reference, ct); }
        catch (CoreProviderException error) when (input.AdmissionRef is null && error.Status == 404) {
            throw new CoreProviderException("original_authorization_not_found", "The exact command has no retained original grant.", 404);
        }
        var original = receipt.Request;
        if (receipt.CallerAppId != consumer.Id || receipt.CallerInstallation != consumer.InstalledAt
            || original.Operation is not ("runs.start" or "runs.respond" or "runs.control" or "sessions.create" or "sessions.configure" or "attachments.write")
            || original.Provider != input.Provider || original.Method != input.Method || original.Operation != input.Operation
            || original.Path != input.Path || original.BodyHash != input.BodyHash
            || original.SessionId != input.SessionId || original.RunId != input.RunId) throw DenyCleanup();
        var provider = await apps.GetAppAsync(original.Provider.AppId, ct) ?? throw DenyCleanup();
        await ValidateRecord(provider, receipt, ct, admitted: false);
        var until = clock.UtcNow.AddMinutes(2);
        if (until > receipt.ExpiresAt) until = receipt.ExpiresAt;
        return new(original.Provider, Descriptor(provider, original.Provider).Url!,
            SignToken(Prefix, new CoreAgentToken(receipt.Id, until.ToUnixTimeSeconds(), receipt.GrantEpoch)), until, receipt.Id, receipt.ExpiresAt, []);
    }

    internal async Task<CoreAgentBinding> AuthorizeCleanup(AppRecord consumer, CoreAgentCleanupRequest input, CancellationToken ct)
    {
        if (input.AdmissionRef is null) throw DenyCleanup();
        var admission = await store.Get(input.AdmissionRef, ct);
        var original = admission.Request;
        if (consumer.Id != admission.CallerAppId || consumer.InstalledAt != admission.CallerInstallation
            || input.Provider != original.Provider || original.Operation != "runs.start" || input.RunId != original.RunId
            || input.SessionId is not null && input.SessionId != original.SessionId
            || input.Operation is not ("runs.read" or "runs.controls.read" or "runs.closure" or "runs.cancel" or "runs.discard"))
            throw DenyCleanup();
        Validate(new(input.Provider, input.Operation, input.Method, input.Path, input.BodyHash, SessionId: original.SessionId, RunId: original.RunId));
        var provider = await apps.GetAppAsync(original.Provider.AppId, ct) ?? throw DenyCleanup();
        var descriptor = Descriptor(provider, original.Provider);
        await ValidateCleanupOwner(provider, consumer, admission, input.Operation, ct);
        var until = clock.UtcNow.AddMinutes(2);
        var token = new CoreAgentCleanupToken(admission.Id, input.Operation, input.Method, input.Path, input.BodyHash, until.ToUnixTimeSeconds());
        return new(original.Provider, descriptor.Url!, SignToken(CleanupPrefix, token), until, admission.Id, until, []);
    }

    private static AppIdentityException DenyCleanup() => new("permission_denied", "The original attempt's cleanup binding is unavailable.");

    private async Task<string> ValidateCleanupOwner(AppRecord provider, AppRecord consumer, CoreAgentAuthorization admission, string operation, CancellationToken ct)
    {
        if (admission.ProtocolVersion != 2 || admission.Request.Operation != "runs.start" || admission.Request.Provider.AppId != provider.Id
            || Descriptor(provider, admission.Request.Provider).Incarnation != admission.ImplementationIncarnation
            || consumer.Id != admission.CallerAppId || consumer.InstalledAt != admission.CallerInstallation
            || !AppManagementAuthorization.HasPermission(consumer, CoreAppPermissions.AgentProviders)) throw DenyCleanup();
        // Stopping one's own existing writer is a containment operation. It carries no transcript
        // or execution authority and remains available after the originating human logs out or is disabled.
        if (operation is "runs.cancel" or "runs.closure" or "runs.controls.read" or "runs.discard") return "service";
        var (user, _) = await identity.RequireAccessibleUserAsync(consumer.Id, admission.UserId, ct);
        await identity.RequireAccessibleUserAsync(provider.Id, admission.UserId, ct);
        if (!AppAccessPolicy.IsAdmin(user)) throw DenyCleanup();
        return user.Role;
    }

    private async Task<CoreAgentInvocation> IntrospectCleanup(AppRecord provider, CoreAgentIntrospection input, CancellationToken ct)
    {
        var token = ReadToken<CoreAgentCleanupToken>(CleanupPrefix, input.Token);
        if (token.Expires <= clock.UtcNow.ToUnixTimeSeconds() || token.Operation != input.Operation || token.Method != input.Method
            || token.Path != input.Path || token.BodyHash != input.BodyHash) throw DenyCleanup();
        var admission = await store.Get(token.AdmissionRef, ct);
        var consumer = await apps.GetAppAsync(admission.CallerAppId, ct) ?? throw DenyCleanup();
        var role = await ValidateCleanupOwner(provider, consumer, admission, input.Operation, ct);
        return new(1, admission.UserId, role, admission.PrincipalId, consumer.Id, consumer.InstalledAt.ToString("O"),
            admission.Request.Provider, token.Operation, null, admission.Id, admission.Request.SessionId, admission.Request.RunId,
            null, null, DateTimeOffset.FromUnixTimeSeconds(token.Expires), admission.Request.BodyHash, CleanupOnly: true);
    }
}
