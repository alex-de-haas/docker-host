namespace Haas.Hosty.Core;

internal static class CoreHistoryEndpoints
{
    private static Task<CoreCapabilityCaller> Caller(HttpRequest request, CoreCapabilityAuthorization auth, string operation, CancellationToken ct)
        => CoreProviderApi.Caller(request, auth, "conversation-history", operation, ct);
    internal static void Map(WebApplication app)
    {
        const string root = "/api/history/v1";
        app.MapGet(root + "/providers", async (HttpRequest request, CoreCapabilityAuthorization auth, CoreHistoryAdapter history, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await history.ProvidersAsync(await Caller(request, auth, "capabilities", ct), ct)));
        app.MapPost(root + "/capabilities", async (CoreHistoryProvider input, HttpRequest request, CoreCapabilityAuthorization auth, CoreHistoryAdapter history, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await history.CapabilitiesAsync(await Caller(request, auth, "capabilities", ct), input.Provider, ct)));
        app.MapPost(root + "/conversations/query", async (CoreConversationQuery input, HttpRequest request, CoreCapabilityAuthorization auth, CoreHistoryAdapter history, CoreHistoryCursorStore cursors, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await history.ConversationsAsync(await Caller(request, auth, "conversations.query", ct), input, cursors, ct)));
        app.MapPost(root + "/conversations/get", async (CoreConversationGet input, HttpRequest request, CoreCapabilityAuthorization auth, CoreHistoryAdapter history, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await history.ConversationAsync(await Caller(request, auth, "conversations.get", ct), input.Conversation, ct)));
        app.MapPost(root + "/entries/query", async (CoreHistoryQuery input, HttpRequest request, CoreCapabilityAuthorization auth, CoreHistoryAdapter history, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await history.ReadAsync(await Caller(request, auth, "entries.query", ct), input, ct)));
        app.MapPost(root + "/entries/get", async (CoreHistoryEntryGet input, HttpRequest request, CoreCapabilityAuthorization auth, CoreHistoryAdapter history, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await history.EntryAsync(await Caller(request, auth, "entries.get", ct), input, ct)));
        app.MapPost(root + "/attachments/resolve", async (CoreHistoryAttachmentResolve input, HttpRequest request, CoreCapabilityAuthorization auth, CoreHistoryAdapter history, CoreHistoryAttachmentHandles handles, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await history.AttachmentAsync(await Caller(request, auth, "attachments.resolve", ct), input, handles, ct)));
        app.MapGet(root + "/attachments/{handle}", async (string handle, HttpContext context, CoreCapabilityAuthorization auth, CoreHistoryAdapter history, CoreHistoryAttachmentHandles handles, CancellationToken ct) =>
        {
            CoreHistoryAttachmentBytes? bytes = null;
            var error = await CoreProviderApi.Handle(async () => { bytes = await history.AttachmentBytesAsync(await Caller(context.Request, auth, "attachments.content", ct), handle, context.Request.Headers.Range, handles, ct); return true; });
            if (bytes is null) return error;
            context.Response.Headers.CacheControl = "no-store";
            context.Response.Headers.XContentTypeOptions = "nosniff";
            context.Response.Headers.AcceptRanges = "bytes";
            if (context.Request.Headers.ContainsKey("Range"))
            {
                context.Response.StatusCode = 206;
                context.Response.Headers.ContentRange = $"bytes {bytes.Offset}-{bytes.Offset + bytes.Bytes.Length - 1}/{bytes.Metadata.SizeBytes}";
            }
            return Results.File(bytes.Bytes, "application/octet-stream", bytes.Metadata.Name);
        });
        app.MapPost(root + "/search", async (CoreHistorySearch input, HttpRequest request, CoreCapabilityAuthorization auth, CoreHistoryAdapter history, CoreHistoryCursorStore cursors, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await history.SearchAsync(await Caller(request, auth, "search", ct), input, cursors, ct)));
        app.MapPost(root + "/shares/query", async (CoreConversationGet input, HttpRequest request, CoreCapabilityAuthorization auth, CoreHistoryAdapter history, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await history.SharesAsync(await Caller(request, auth, "shares.query", ct), input.Conversation, ct)));
        app.MapPost(root + "/shares/create", async (CoreHistoryShareCreate input, HttpRequest request, CoreCapabilityAuthorization auth, CoreHistoryAdapter history, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await history.ShareAsync(await Caller(request, auth, "shares.create", ct), input, ct)));
        app.MapPost(root + "/shares/revoke", async (CoreHistoryShareRevoke input, HttpRequest request, CoreCapabilityAuthorization auth, CoreHistoryAdapter history, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await history.RevokeShareAsync(await Caller(request, auth, "shares.revoke", ct), input, ct)));
        app.MapGet(root + "/operations/{requestId}", async (string requestId, HttpRequest request, CoreCapabilityAuthorization auth, CoreProviderOperationStore operations, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await OperationAsync(await Caller(request, auth, "capabilities", ct), requestId, operations, ct)));
    }
    internal static async Task<CoreProviderOperationReceipt> OperationAsync(CoreCapabilityCaller caller, string requestId, CoreProviderOperationStore operations, CancellationToken ct)
    {
        var receipt = await operations.GetAsync(caller, requestId, ct);
        if (receipt.Kind != "conversation-history") throw new CoreProviderException("not_found", "History operation not found.", 404);
        CoreProviderPolicy.For(receipt.Kind, receipt.Operation).Require(caller);
        return receipt;
    }
}
