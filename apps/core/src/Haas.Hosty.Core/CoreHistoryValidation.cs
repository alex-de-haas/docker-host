using System.Text;
using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

// Enforce the common envelope and negotiated extension/schema bounds. No provider-supplied URL,
// extension schema or fallback text is executed or used as independent resource authority.
internal static class CoreHistoryValidation
{
    internal static readonly string[] Kinds = ["message", "tool_call", "tool_result", "run_state", "usage", "extension"];
    internal static void Page(int limit, string? cursor)
    {
        if (limit is < 1 or > 200 || cursor?.Length > 16384) throw Input("Use page size 1–200 and a bounded continuation cursor.");
    }
    internal static void Conversation(HostyConversationRef? reference)
    {
        if (reference is null) throw Input("Select a qualified conversation.");
        CoreProviderMediation.ValidateReference(reference.Provider); CoreProviderMediation.ValidateId(reference.Id);
    }
    internal static void EntryRef(HostyHistoryEntryRef? reference)
    {
        if (reference is null) throw Input("Select a qualified entry.");
        Conversation(reference.Conversation); CoreProviderMediation.ValidateId(reference.Id);
    }
    internal static void Coverage(HostyHistoryCoverage? coverage)
    {
        if (coverage is null || coverage.State is not ("complete" or "partial") || coverage.Reasons is null
            || coverage.Reasons.Length > 32 || coverage.Reasons.Any(r => r is null || r.Length > 500)) throw Invalid("Invalid history coverage.");
    }
    internal static void Capabilities(HostyHistoryCapabilities capabilities)
    {
        if (capabilities.Version != 1 || capabilities.EntryKinds is not { Length: > 0 and <= 6 }
            || capabilities.EntryKinds.Any(k => !Kinds.Contains(k)) || capabilities.MaxPageSize is < 1 or > 200
            || capabilities.SnapshotLifetimeSeconds < 900 || capabilities.Extensions is null || capabilities.Extensions.Length > 32)
            throw Invalid("Invalid version-one history capabilities.");
        var declared = new HashSet<string>(StringComparer.Ordinal);
        foreach (var extension in capabilities.Extensions)
        {
            if (extension.Name is null || extension.Name.Length > 256 || !extension.Name.Contains('/') || !extension.Name.Split('/')[0].Contains('.')
                || extension.Version < 1 || !declared.Add(extension.Name + ":" + extension.Version)
                || extension.Schema.ValueKind != JsonValueKind.Object || Bytes(extension.Schema) > 65536 || !SafeSchema(extension.Schema, 0))
                throw Invalid("Extension schemas must be bounded inline namespaced declarations without remote references.");
        }
    }
    private static bool SafeSchema(JsonElement value, int depth)
    {
        if (depth > 32) return false;
        if (value.ValueKind == JsonValueKind.Object)
            foreach (var property in value.EnumerateObject())
            {
                if (property.Name is "$ref" or "$dynamicRef" && (property.Value.ValueKind != JsonValueKind.String || property.Value.GetString()?.StartsWith('#') != true)) return false;
                if (!SafeSchema(property.Value, depth + 1)) return false;
            }
        if (value.ValueKind == JsonValueKind.Array)
            foreach (var item in value.EnumerateArray()) if (!SafeSchema(item, depth + 1)) return false;
        return true;
    }
    internal static void Metadata(HostyConversation conversation, HostyProviderRef provider, string? id = null)
    {
        Conversation(conversation.Ref);
        if (conversation.Ref.Provider != provider || id is not null && conversation.Ref.Id != id || conversation.Title?.Length > 1000
            || string.IsNullOrWhiteSpace(conversation.OwnerUserId) || conversation.Capabilities is null || conversation.Capabilities.Length > 32)
            throw Invalid("The source returned invalid conversation metadata.");
        CoreAgentSessionAdapter.Revision(conversation.Revision);
        Time(conversation.CreatedAt); Time(conversation.UpdatedAt);
        foreach (var native in conversation.NativeSessions ?? []) { CoreProviderMediation.ValidateReference(native.Provider); CoreProviderMediation.ValidateId(native.Id); }
    }
    internal static void Entry(HostyHistoryEntry entry, HostyProviderRef provider, HostyHistoryCapabilities capabilities,
        string? conversationId = null, string? entryId = null)
    {
        EntryRef(entry.Ref);
        if (entry.Ref.Conversation.Provider != provider || conversationId is not null && entry.Ref.Conversation.Id != conversationId
            || entryId is not null && entry.Ref.Id != entryId || Bytes(JsonSerializer.SerializeToElement(entry, CoreJson.TypeInfo<HostyHistoryEntry>())) > 256 * 1024
            || entry.Actor?.Kind is not ("user" or "agent" or "system" or "tool")) throw Invalid("The source returned an invalid or oversized entry.");
        CoreAgentSessionAdapter.Revision(entry.Revision); CoreAgentSessionAdapter.Revision(entry.Sequence);
        Time(entry.CreatedAt); Time(entry.UpdatedAt);
        if (entry.Actor.Id?.Length > 256 || entry.Actor.DisplayName?.Length > 500) throw Invalid("Invalid public actor metadata.");
        if (entry.Run is not null) { CoreProviderMediation.ValidateReference(entry.Run.Provider); CoreProviderMediation.ValidateId(entry.Run.Id); }
        if (entry.ParentEntryId is not null) CoreProviderMediation.ValidateId(entry.ParentEntryId);
        var data = entry.Data;
        if (data.ValueKind != JsonValueKind.Object || !String(data, "kind", out var kind) || !capabilities.EntryKinds.Contains(kind))
            throw Invalid("The source returned an undeclared entry kind.");
        switch (kind)
        {
            case "message":
                if (!String(data, "role", out var role) || role is not ("user" or "assistant" or "system")
                    || !String(data, "state", out var state) || state is not ("streaming" or "complete" or "interrupted")) throw Invalid("Invalid message entry.");
                Parts(data); break;
            case "tool_call":
                RequiredId(data, "callId"); RequiredId(data, "toolName");
                if (!data.TryGetProperty("input", out _)) throw Invalid("Tool calls must explicitly disclose their input or redaction.");
                Disclosure(data); break;
            case "tool_result":
                RequiredId(data, "callId"); Parts(data); Disclosure(data);
                NonnegativeNumber(data, "durationMs");
                if (!String(data, "outcome", out var outcome) || outcome is not ("completed" or "failed" or "cancelled" or "unknown")) throw Invalid("Invalid tool outcome.");
                break;
            case "run_state":
                RequiredId(data, "state"); if (!data.TryGetProperty("stopConfirmed", out var stop) || stop.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw Invalid("Run events require explicit stop confirmation.");
                break;
            case "usage":
                if (!String(data, "scope", out var scope) || scope is not ("turn" or "run") || !String(data, "source", out _)
                    || !data.TryGetProperty("estimated", out var estimated) || estimated.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw Invalid("Invalid usage disclosure.");
                foreach (var count in new[] { "inputTokens", "outputTokens", "cachedInputTokens" })
                    if (data.TryGetProperty(count, out var amount) && (!amount.TryGetInt64(out var number) || number < 0 || number > 9007199254740991)) throw Invalid("Usage counts must be nonnegative safe integers.");
                if (data.TryGetProperty("cost", out var cost) && (cost.ValueKind != JsonValueKind.Object || !String(cost, "amount", out var amountText)
                    || amountText.Length > 64 || !decimal.TryParse(amountText, System.Globalization.NumberStyles.AllowDecimalPoint, System.Globalization.CultureInfo.InvariantCulture, out var costAmount)
                    || costAmount < 0 || !String(cost, "currency", out var currency) || currency.Length is < 1 or > 16)) throw Invalid("Invalid usage cost metadata.");
                break;
            case "extension":
                if (!String(data, "name", out var name) || !data.TryGetProperty("version", out var version) || !version.TryGetInt32(out var v)
                    || !capabilities.Extensions.Any(e => e.Name == name && e.Version == v) || !data.TryGetProperty("payload", out var payload)
                    || Bytes(payload) > 65536 || data.TryGetProperty("fallbackText", out var fallback) && (fallback.ValueKind != JsonValueKind.String || fallback.GetString()!.Length > 8192))
                    throw Invalid("The extension is undeclared or exceeds its negotiated payload bounds.");
                Disclosure(data); break;
        }
    }
    private static void Parts(JsonElement data)
    {
        if (!data.TryGetProperty("parts", out var parts) || parts.ValueKind != JsonValueKind.Array || parts.GetArrayLength() > 200)
            throw Invalid("Content parts must be a bounded array.");
        foreach (var part in parts.EnumerateArray())
        {
            if (!String(part, "type", out var type)) throw Invalid("Content parts require an explicit type.");
            switch (type)
            {
                case "text":
                    if (!String(part, "text", out _) || !String(part, "format", out var format) || format is not ("plain" or "markdown")) throw Invalid("Invalid text part."); break;
                case "attachment":
                    RequiredId(part, "attachmentId"); RequiredId(part, "revision"); RequiredId(part, "mediaType");
                    CoreAgentSessionAdapter.Revision(part.GetProperty("revision").GetString()); NonnegativeNumber(part, "sizeBytes", true);
                    if (!String(part, "name", out var name) || name.Length > 1000) throw Invalid("Invalid attachment metadata."); break;
                case "resource": RequiredId(part, "resourceKind"); RequiredId(part, "owner"); RequiredId(part, "id");
                    if (part.TryGetProperty("revision", out var resourceRevision)) { if (resourceRevision.ValueKind != JsonValueKind.String) throw Invalid("Invalid resource revision."); CoreAgentSessionAdapter.Revision(resourceRevision.GetString()); }
                    break;
                default: throw Invalid("Unknown common content part.");
            }
        }
    }
    private static void Time(DateTimeOffset value)
    { if (value == default || value.Offset != TimeSpan.Zero) throw Invalid("History times must be explicit UTC timestamps."); }
    private static void NonnegativeNumber(JsonElement value, string name, bool integer = false)
    {
        if (!value.TryGetProperty(name, out var amount)) return;
        if (amount.ValueKind != JsonValueKind.Number || !amount.TryGetDouble(out var number) || !double.IsFinite(number) || number < 0
            || integer && (!amount.TryGetInt64(out var count) || count > 9007199254740991)) throw Invalid("Invalid " + name + ".");
    }
    private static void Disclosure(JsonElement data)
    {
        if (!String(data, "disclosure", out var value) || value is not ("complete" or "redacted" or "truncated")) throw Invalid("Explicit disclosure metadata is required.");
    }
    private static void RequiredId(JsonElement value, string name)
    { if (!String(value, name, out var id) || string.IsNullOrWhiteSpace(id) || id.Length > 256) throw Invalid("Invalid " + name + "."); }
    private static bool String(JsonElement value, string name, out string text)
    {
        text = "";
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.String) return false;
        text = property.GetString()!; return true;
    }
    internal static int Bytes(JsonElement value) => Encoding.UTF8.GetByteCount(value.GetRawText());
    internal static CoreProviderException Input(string message) => new("invalid_input", message, 400);
    internal static CoreProviderException Invalid(string message) => new("provider_response_invalid", message, 502);
}
