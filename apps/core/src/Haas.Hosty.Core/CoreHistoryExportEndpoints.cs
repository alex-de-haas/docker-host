using System.Net;
using Microsoft.AspNetCore.Cors;

namespace Haas.Hosty.Core;

internal static class CoreHistoryExportEndpoints
{
    internal static Task<CoreCapabilityCaller> Caller(HttpRequest request, CoreCapabilityAuthorization auth, CancellationToken ct)
        => auth.RequireAsync(request, [], [], ct, administrator: false);
    internal static void Map(WebApplication app)
    {
        const string root = "/api/history/v1/exports";
        app.MapPost(root + "/create", async (CoreHistoryExportCreate input, HttpRequest request, CoreCapabilityAuthorization auth, CoreHistoryExports exports, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await exports.CreateAsync(await Caller(request, auth, ct), input, ct)));
        app.MapPost(root + "/get", async (CoreHistoryExportGet input, HttpRequest request, CoreCapabilityAuthorization auth, CoreHistoryExports exports, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await exports.GetAsync(await Caller(request, auth, ct), input.ExportGrantId, ct)));
        app.MapPost(root + "/acknowledge", async (CoreHistoryExportAcknowledge input, HttpRequest request, CoreCapabilityAuthorization auth, CoreHistoryExports exports, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await exports.AcknowledgeAsync(await Caller(request, auth, ct), input, ct)));
        app.MapPost(root + "/revoke", async (CoreHistoryExportRevoke input, HttpRequest request, CoreCapabilityAuthorization auth, CoreHistoryExports exports, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await exports.RevokeAsync(await Caller(request, auth, ct), input, ct)));
        foreach (var kind in new[] { "snapshot", "changes" })
        {
            var changes = kind == "changes";
            app.MapPost(root + "/" + kind, async (CoreHistoryExportQuery input, HttpRequest request, CoreCapabilityAuthorization auth, CoreHistoryExports exports, CancellationToken ct) =>
                await CoreProviderApi.Handle(async () => await exports.BatchAsync(await Caller(request, auth, ct), input, changes, ct)));
        }
        // A reviewed index consumer can use its service identity only for its exact approved export.
        // This creates no general user identity or permission to read arbitrary conversation history.
        const string consumerRoot = "/api/internal/apps/{appId}/history-exports";
        app.MapPost(consumerRoot + "/get", async (string appId, CoreHistoryExportGet input, HttpRequest request, CoreHistoryExports exports, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await exports.GetAsync(await exports.ConsumerAsync(request, appId, input.ExportGrantId, ct), input.ExportGrantId, ct)));
        app.MapPost(consumerRoot + "/acknowledge", async (string appId, CoreHistoryExportAcknowledge input, HttpRequest request, CoreHistoryExports exports, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await exports.AcknowledgeAsync(await exports.ConsumerAsync(request, appId, input.ExportGrantId, ct), input, ct)));
        foreach (var kind in new[] { "snapshot", "changes" })
        {
            var changes = kind == "changes";
            app.MapPost(consumerRoot + "/" + kind, async (string appId, CoreHistoryExportQuery input, HttpRequest request, CoreHistoryExports exports, CancellationToken ct) =>
                await CoreProviderApi.Handle(async () => await exports.BatchAsync(await exports.ConsumerAsync(request, appId, input.ExportGrantId, ct), input, changes, ct)));
        }
        MapReview(app);
    }
    private static void MapReview(WebApplication app)
    {
        const string route = "/account/history-exports/{id}";
        app.MapGet(route, async (string id, HttpContext context, CoreHistoryExportStore store, UserDirectoryStore users,
            AppRegistryStore apps, IClock clock) =>
        {
            InstallationApprovalEndpoints.ProtectPage(context.Response);
            if (!InstallationApprovalEndpoints.IsPageNavigation(context.Request) || !await InstallationApprovalEndpoints.HasIsolatedCookieHostAsync(context.Request, apps, context.RequestAborted)) return Results.StatusCode(403);
            var actor = await InstallationApprovalEndpoints.BrowserActorAsync(context.Request, users, clock, context.RequestAborted);
            if (actor is null) return Results.Redirect("/login?returnTo=" + Uri.EscapeDataString("/account/history-exports/" + id));
            try
            {
                var review = await store.NonceAsync(id, actor.Id, AppIdentityService.HashToken(CoreSessionAuthorization.ReadSessionId(context.Request)!), context.RequestAborted);
                return Results.Content(Render(review.Record, review.Nonce), "text/html");
            }
            catch (CoreProviderException ex) { return CoreJson.Json(new CoreProviderFailure(ex.Error), ex.Status); }
        }).WithMetadata(new DisableCorsAttribute());
        app.MapPost(route, async (string id, HttpContext context, CoreHistoryExportStore store, CoreHistoryExports exports,
            UserDirectoryStore users, AppRegistryStore apps, IClock clock) =>
        {
            InstallationApprovalEndpoints.ProtectPage(context.Response);
            if (!InstallationApprovalEndpoints.IsSameOriginDecision(context.Request) || !await InstallationApprovalEndpoints.HasIsolatedCookieHostAsync(context.Request, apps, context.RequestAborted)) return Results.StatusCode(403);
            var actor = await InstallationApprovalEndpoints.BrowserActorAsync(context.Request, users, clock, context.RequestAborted);
            if (actor is null) return Results.StatusCode(403);
            var credential = AppIdentityService.HashToken(CoreSessionAuthorization.ReadSessionId(context.Request)!);
            var caller = new CoreCapabilityCaller(actor, CoreCapabilityAuthorization.OperatorPrincipal(actor.Id, credential), null, null, true)
            { Authority = new("operator", CredentialHash: credential) };
            var form = await context.Request.ReadFormAsync(context.RequestAborted);
            if (form["decision"].ToString() is not ("approve" or "revoke")) return Results.StatusCode(400);
            try
            {
                await store.DecideAsync(id, actor.Id, credential, form["nonce"].ToString(), form["revision"].ToString(), form["decision"] == "approve",
                    record => exports.ValidateApprovalAsync(record, caller, context.RequestAborted), context.RequestAborted);
                return Results.Content(Render(await store.ReadAsync(id, context.RequestAborted), null), "text/html");
            }
            catch (CoreProviderException ex) { return CoreJson.Json(new CoreProviderFailure(ex.Error), ex.Status); }
            catch (AppIdentityException ex) { return CoreJson.Json(new CoreProviderFailure(new(ex.Code, ex.Message, false)), AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
        }).WithMetadata(new DisableCorsAttribute());
    }
    private static string Render(CoreHistoryExportRecord record, string? nonce)
    {
        static string E(string? value) => WebUtility.HtmlEncode(value ?? "");
        var grant = record.Grant;
        var consumer = record.ConsumerLabel ?? (grant.Consumer!.Kind == "app" ? grant.Consumer.AppId : "The requesting client");
        var sources = string.Join("", CoreHistoryExportStore.Providers(record).Select(p => $"<li>{E(p.AppId)} / {E(p.Key)}<br><small>Installation: {E(p.InstallationId)}</small></li>"));
        var corpus = grant.Corpus!.Mode == "all-owned" ? "All your conversations from these sources, including conversations you create later."
            : $"Only these {grant.Corpus.Conversations!.Length} selected conversations: <ul>" + string.Join("", grant.Corpus.Conversations.Select(c => $"<li>{E(c.Id)} ({E(c.Provider.AppId)})</li>")) + "</ul>";
        var decision = nonce is null || grant.State is not ("proposed" or "active") ? "" : $"<form method=\"post\"><input type=\"hidden\" name=\"nonce\" value=\"{E(nonce)}\"><input type=\"hidden\" name=\"revision\" value=\"{E(grant.Revision)}\">"
            + (grant.State == "proposed" ? "<button name=\"decision\" value=\"approve\">Allow indexing of this corpus</button> " : "")
            + "<button name=\"decision\" value=\"revoke\">Revoke / decline export</button></form>";
        var consumerIdentity = grant.Consumer!.Kind == "app" ? $"<small>{E(grant.Consumer.AppId)} / {E(grant.Consumer.InstallationId)}</small>" : "";
        var body = $"<p>Status: <strong>{E(grant.State)}</strong></p><p>Consumer: <strong>{E(consumer)}</strong><br>{consumerIdentity}</p><p>Purpose: {E(grant.Purpose)}</p><p>{corpus}</p><ul>{sources}</ul>"
            + $"<p>Expires: {E(grant.ExpiresAt?.ToString("u") ?? "No automatic expiry; you can revoke this grant.")}</p>"
            + "<p>This permits a derived search index of your selected source history. It excludes conversations shared by other owners. Revocation stops new exports and tells this consumer to purge its copy; it cannot retract copies outside the consumer's control.</p>" + decision;
        return CoreBrowserPages.Approval("History export", "Review conversation indexing", null, record.CreatorLabel ?? "Core client", body);
    }
}
