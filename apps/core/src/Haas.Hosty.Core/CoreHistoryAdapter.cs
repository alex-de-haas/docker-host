using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed partial class CoreHistoryAdapter(CoreProviderMediation providers, AppIdentityService identity,
    UserDirectoryStore users, IClock clock)
{
    internal Task<ProviderDirectory> ProvidersAsync(CoreCapabilityCaller caller, CancellationToken ct)
        => providers.ListAsync(caller, "conversation-history", ct);
    internal async Task<HostyHistoryCapabilities> CapabilitiesAsync(CoreCapabilityCaller caller, HostyProviderRef provider, CancellationToken ct)
    {
        var result = await Send<JsonElement?>(caller, provider, "capabilities", "GET", "/capabilities", null, [], null, ct);
        var capabilities = result.Deserialize(CoreJson.TypeInfo<HostyHistoryCapabilities>()) ?? throw Invalid();
        CoreHistoryValidation.Capabilities(capabilities); return capabilities;
    }
    internal async Task<JsonElement> ConversationAsync(CoreCapabilityCaller caller, HostyConversationRef reference, CancellationToken ct)
    {
        CoreHistoryValidation.Conversation(reference);
        var result = await Send(caller, reference.Provider, "conversations.get", "POST", "/conversations/get", new CoreConversationGet(reference), [reference.Id], null, ct);
        var conversation = result.Deserialize(CoreJson.TypeInfo<HostyConversation>()) ?? throw Invalid();
        CoreHistoryValidation.Metadata(conversation, reference.Provider, reference.Id); return result;
    }
    internal async Task<JsonElement> ReadAsync(CoreCapabilityCaller caller, CoreHistoryQuery input, CancellationToken ct)
    {
        CoreHistoryValidation.Conversation(input.Conversation); CoreHistoryValidation.Page(input.Limit, input.Cursor);
        ValidateKinds(input.Kinds);
        var capabilities = await CapabilitiesAsync(caller, input.Conversation.Provider, ct);
        var result = await Send(caller, input.Conversation.Provider, "entries.query", "POST", "/entries/query", input, [input.Conversation.Id], null, ct);
        var page = result.Deserialize(CoreJson.TypeInfo<HostyHistoryPage>()) ?? throw Invalid();
        if (page.Entries is null || page.Entries.Length > input.Limit || !result.TryGetProperty("entries", out var entries) || entries.ValueKind != JsonValueKind.Array) throw Invalid();
        foreach (var raw in entries.EnumerateArray()) ValidateEntry(raw, input.Conversation.Provider, capabilities, input.Conversation.Id);
        CoreHistoryValidation.Coverage(page.Coverage); CoreAgentSessionAdapter.Revision(page.HighWater);
        return result;
    }
    internal async Task<JsonElement> EntryAsync(CoreCapabilityCaller caller, CoreHistoryEntryGet input, CancellationToken ct)
    {
        CoreHistoryValidation.EntryRef(input.Entry);
        if (input.ExpectedRevision is not null) CoreAgentSessionAdapter.Revision(input.ExpectedRevision);
        var provider = input.Entry.Conversation.Provider;
        var capabilities = await CapabilitiesAsync(caller, provider, ct);
        var result = await Send(caller, provider, "entries.get", "POST", "/entries/get", input, [input.Entry.Conversation.Id, input.Entry.Id], null, ct);
        var entry = ValidateEntry(result, provider, capabilities, input.Entry.Conversation.Id, input.Entry.Id);
        if (input.ExpectedRevision is not null && entry.Revision != input.ExpectedRevision)
            throw new CoreProviderException("revision_conflict", "Read the current source entry before using this revision.", 409);
        return result;
    }
    internal async Task<HostyHistorySharePage> SharesAsync(CoreCapabilityCaller caller, HostyConversationRef reference, CancellationToken ct)
    {
        CoreHistoryValidation.Conversation(reference);
        var result = await Send(caller, reference.Provider, "shares.query", "POST", "/shares/query", new CoreConversationGet(reference), [reference.Id], null, ct);
        var page = result.Deserialize(CoreJson.TypeInfo<HostyHistorySharePage>()) ?? throw Invalid();
        if (page.Shares is null || page.Shares.Length > 200 || page.Shares.Any(g => g.Ref != reference
            || g.OwnerUserId != caller.User.Id && !g.RecipientUserIds.Contains(caller.User.Id))) throw Invalid();
        CoreAgentSessionAdapter.Revision(page.ConversationRevision); return page;
    }
    internal async Task<HostyHistoryShareReceipt> ShareAsync(CoreCapabilityCaller caller, CoreHistoryShareCreate input, CancellationToken ct)
    {
        CoreHistoryValidation.Conversation(input.Ref); CoreAgentSessionAdapter.Revision(input.ExpectedRevision);
        ValidateSelection(input.Selection);
        if (input.RecipientUserIds is not { Length: > 0 and <= 16 } || input.RecipientUserIds.Distinct(StringComparer.Ordinal).Count() != input.RecipientUserIds.Length
            || input.Label?.Length > 200 || input.ExpiresAt <= clock.UtcNow || input.Extensions?.Length > 32)
            throw CoreHistoryValidation.Input("Select 1–16 distinct recipients, a bounded label and an optional future expiration.");
        var state = await users.ReadAsync(ct);
        foreach (var recipient in input.RecipientUserIds)
        {
            if (!state.Users.Any(u => u.Id == recipient && !u.Disabled) || recipient == caller.User.Id)
                throw new CoreProviderException("not_found", "A selected recipient is unavailable.", 404);
            try { await identity.RequireAccessibleUserAsync(input.Ref.Provider.AppId, recipient, ct); }
            catch (AppIdentityException) { throw new CoreProviderException("not_found", "A selected recipient is unavailable.", 404); }
        }
        var conversation = (await ConversationAsync(caller, input.Ref, ct)).Deserialize(CoreJson.TypeInfo<HostyConversation>())!;
        if (conversation.OwnerUserId != caller.User.Id) throw new CoreProviderException("permission_denied", "Only the source owner can share; recipients cannot reshare.", 403);
        input = input with { Selection = input.Selection with { EntryIds = input.Selection.EntryIds?.Order(StringComparer.Ordinal).ToArray() }, RecipientUserIds = input.RecipientUserIds.Order(StringComparer.Ordinal).ToArray(),
            Extensions = (input.Extensions ?? []).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray() };
        var result = await Send(caller, input.Ref.Provider, "shares.create", "POST", "/shares/create", input,
            [input.Ref.Id], input.RequestId, ct);
        var receipt = ShareReceipt(result, caller, input.Ref, input.RequestId);
        if (receipt.Grant.State != "active" || receipt.Grant.IncludeAttachments != input.IncludeAttachments
            || !receipt.Grant.RecipientUserIds.SequenceEqual(input.RecipientUserIds) || !receipt.Grant.Extensions.SequenceEqual(input.Extensions!)
            || receipt.Grant.Label != input.Label || receipt.Grant.ExpiresAt != input.ExpiresAt
            || CoreJson.Text(receipt.Grant.Selection) != CoreJson.Text(input.Selection)) throw Invalid();
        return receipt;
    }
    internal async Task<HostyHistoryShareReceipt> RevokeShareAsync(CoreCapabilityCaller caller, CoreHistoryShareRevoke input, CancellationToken ct)
    {
        CoreHistoryValidation.Conversation(input.Ref); CoreAgentSessionAdapter.Revision(input.ExpectedRevision); CoreProviderMediation.ValidateId(input.GrantId);
        var conversation = (await ConversationAsync(caller, input.Ref, ct)).Deserialize(CoreJson.TypeInfo<HostyConversation>())!;
        if (conversation.OwnerUserId != caller.User.Id) throw new CoreProviderException("permission_denied", "Only the source owner can revoke this share.", 403);
        var result = await Send(caller, input.Ref.Provider, "shares.revoke", "POST", "/shares/revoke", input, [input.Ref.Id, input.GrantId], input.RequestId, ct);
        var receipt = ShareReceipt(result, caller, input.Ref, input.RequestId);
        if (receipt.Grant.Id != input.GrantId || receipt.Grant.State != "revoked") throw Invalid();
        return receipt;
    }
    private static HostyHistoryShareReceipt ShareReceipt(JsonElement value, CoreCapabilityCaller caller, HostyConversationRef reference, string requestId)
    {
        var receipt = value.Deserialize(CoreJson.TypeInfo<HostyHistoryShareReceipt>()) ?? throw Invalid();
        if (receipt.Grant?.Ref != reference || receipt.Grant.OwnerUserId != caller.User.Id
            || !Guid.TryParse(receipt.RequestId, out var id) || id != Guid.Parse(requestId)) throw Invalid();
        CoreAgentSessionAdapter.Revision(receipt.ConversationRevision); return receipt;
    }
    internal static void ValidateSelection(HostyHistorySelection? selection)
    {
        if (selection is null || selection.IncludeFutureEntries == true && selection.EntryIds is not null
            || selection.IncludeFutureEntries != true && (selection.EntryIds is not { Length: > 0 and <= 200 }
                || selection.EntryIds.Distinct(StringComparer.Ordinal).Count() != selection.EntryIds.Length))
            throw CoreHistoryValidation.Input("Select fixed entry IDs or explicitly include the whole conversation and future entries.");
        foreach (var id in selection.EntryIds ?? []) CoreProviderMediation.ValidateId(id);
    }
    internal static void ValidateKinds(string[]? kinds)
    {
        if (kinds is not null && (kinds.Length is < 1 or > 6 || kinds.Any(k => !CoreHistoryValidation.Kinds.Contains(k))))
            throw CoreHistoryValidation.Input("Select declared common entry kinds.");
    }
    private static HostyHistoryEntry ValidateEntry(JsonElement raw, HostyProviderRef provider, HostyHistoryCapabilities capabilities, string? conversationId = null, string? entryId = null)
    {
        if (CoreHistoryValidation.Bytes(raw) > 256 * 1024) throw Invalid();
        var entry = raw.Deserialize(CoreJson.TypeInfo<HostyHistoryEntry>()) ?? throw Invalid();
        CoreHistoryValidation.Entry(entry, provider, capabilities, conversationId, entryId); return entry;
    }
    private Task<JsonElement> Send<T>(CoreCapabilityCaller caller, HostyProviderRef provider, string operation, string method,
        string path, T input, string[] resources, string? requestId, CancellationToken ct)
        => providers.SendAsync(caller, provider, CoreProviderPolicy.For("conversation-history", operation), method, path, input, resources, requestId, ct);
    private static CoreProviderException Invalid() => CoreHistoryValidation.Invalid("The source returned invalid history data.");
}
