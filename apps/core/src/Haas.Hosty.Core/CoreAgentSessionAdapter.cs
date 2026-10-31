using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreAgentSessionQuery(HostyProviderRef Provider, HostyConversationRef? Conversation = null, string? Cursor = null, int Limit = 50);
internal sealed record CoreAgentSessionGet(HostyNativeSessionRef NativeSession);
internal sealed record CoreAgentRunGet(HostyRunRef Run);
internal sealed record CoreAgentRunCancel(HostyRunRef Run, string RequestId, string ExpectedRevision);
internal sealed partial class CoreAgentSessionAdapter(CoreProviderMediation providers) : ICoreAgentRunAccess
{
    internal Task<ProviderDirectory> ProvidersAsync(CoreCapabilityCaller caller, CancellationToken ct) => providers.ListAsync(caller, "agent-sessions", ct);
    internal async Task<JsonElement> ListAsync(CoreCapabilityCaller caller, CoreAgentSessionQuery input, CancellationToken ct)
    {
        if (input.Limit is < 1 or > 200 || input.Cursor?.Length > 4096) throw new CoreProviderException("invalid_input", "Use page size 1–200 and a bounded cursor.", 400);
        var result = await providers.SendAsync(caller, input.Provider, CoreProviderPolicy.For("agent-sessions", "sessions.query"), "POST", "/sessions/query", input,
            input.Conversation is null ? [] : [input.Conversation.Id], null, ct);
        var page = result.Deserialize(CoreJson.TypeInfo<HostyAgentSessionPage>()) ?? throw Invalid();
        if (page.Sessions is null || page.Sessions.Length > input.Limit || page.Availability is not ("available" or "partial" or "unavailable")) throw Invalid();
        foreach (var session in page.Sessions) Check(session, input.Provider);
        return result;
    }
    internal async Task<JsonElement> GetAsync(CoreCapabilityCaller caller, CoreAgentSessionGet input, CancellationToken ct)
    {
        if (input.NativeSession is null) throw new CoreProviderException("invalid_reference", "Select a qualified native session.", 400);
        CoreProviderMediation.ValidateId(input.NativeSession.Id);
        var result = await providers.SendAsync(caller, input.NativeSession.Provider, CoreProviderPolicy.For("agent-sessions", "sessions.get"), "POST", "/sessions/get", input, [input.NativeSession.Id], null, ct);
        var session = result.Deserialize(CoreJson.TypeInfo<HostyAgentSession>()) ?? throw Invalid();
        Check(session, input.NativeSession.Provider);
        if (session.Ref != input.NativeSession) throw Invalid();
        return result;
    }
    public async Task<HostyAgentRun> ReadRunAsync(CoreCapabilityCaller caller, HostyRunRef run, CancellationToken ct)
    {
        if (run is null) throw new CoreProviderException("invalid_reference", "Select a qualified run.", 400);
        CoreProviderMediation.ValidateId(run.Id);
        var result = await providers.SendAsync(caller, run.Provider, CoreProviderPolicy.For("agent-sessions", "runs.get"), "POST", "/runs/get", new CoreAgentRunGet(run), [run.Id], null, ct);
        var value = result.Deserialize(CoreJson.TypeInfo<HostyAgentRun>()) ?? throw Invalid();
        Check(value, run); return value;
    }
    internal async Task<HostyRunCancelReceipt> CancelAsync(CoreCapabilityCaller caller, CoreAgentRunCancel input, CancellationToken ct)
    {
        if (input.Run is null) throw new CoreProviderException("invalid_reference", "Select a qualified run.", 400);
        CoreProviderMediation.ValidateId(input.Run.Id); Revision(input.ExpectedRevision);
        var result = await providers.SendAsync(caller, input.Run.Provider, CoreProviderPolicy.For("agent-sessions", "runs.cancel"), "POST", "/runs/cancel", input, [input.Run.Id], input.RequestId, ct);
        var receipt = result.Deserialize(CoreJson.TypeInfo<HostyRunCancelReceipt>()) ?? throw Invalid();
        Check(receipt.Run, input.Run);
        if (!Guid.TryParse(receipt.RequestId, out var request) || request != Guid.Parse(input.RequestId) || receipt.State is not ("accepted" or "completed")) throw Invalid();
        return receipt;
    }
    private static void Check(HostyAgentSession session, HostyProviderRef provider)
    {
        if (session.Ref?.Provider != provider || session.ActiveRuns is null || session.Capabilities is null
            || session.ActiveRuns.Length > 200 || session.ActiveRuns.Any(r => r.Provider != provider)) throw Invalid();
        CoreProviderMediation.ValidateId(session.Ref.Id); Revision(session.Revision);
    }
    private static void Check(HostyAgentRun run, HostyRunRef expected)
    {
        if (run.Ref != expected || run.State is not ("queued" or "running" or "waiting_for_input" or "succeeded" or "failed" or "cancelled" or "unknown")
            || run.Freshness is not ("current" or "last_known" or "unavailable") || run.StopConfirmed && run.Freshness != "current") throw Invalid();
        Revision(run.Revision);
    }
    internal static void Revision(string? revision)
    {
        if (string.IsNullOrEmpty(revision) || revision.Length > 40 || revision.Any(c => c is < '0' or > '9'))
            throw new CoreProviderException("invalid_revision", "Revisions are bounded decimal strings.", 400);
    }
    private static CoreProviderException Invalid() => new("provider_response_invalid", "The execution provider returned an invalid or differently qualified observation.", 502);
}
