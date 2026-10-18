namespace Haas.Hosty.Core;

// Captured before detaching work: a background completion must never consult a recycled HttpContext.
internal sealed class LifecycleAuditOperation(string appId, string verb, string? actorUserId, string via, string? tool = null)
{
    private static readonly object ContextKey = new();
    private readonly string operationId = Guid.NewGuid().ToString("N");
    public bool Accepted { get; private set; }

    public static LifecycleAuditOperation? Current(HttpRequest request)
        => request.HttpContext.Items[ContextKey] as LifecycleAuditOperation;

    public void Attach(HttpContext context) => context.Items[ContextKey] = this;

    public async Task AcceptAsync(AuditStore? audit, IClock clock)
    {
        Accepted = true;
        await WriteAsync(audit, clock, "accepted");
    }

    public async Task WriteAsync(AuditStore? audit, IClock clock, string outcome)
    {
        if (audit is null) return;
        try
        {
            var details = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["via"] = via,
                ["operationId"] = operationId,
            };
            if (tool is not null) details["tool"] = tool;
            await audit.AppendAsync(new AuditRecord($"audit_{Guid.NewGuid():N}", $"app.lifecycle.{verb}", "app",
                appId, outcome, actorUserId, clock.UtcNow, details), CancellationToken.None);
        }
        catch (Exception ex)
        {
            // The mutation's outcome is already settled; storage failure must not invite a retry.
            Console.Error.WriteLine($"[audit] Could not record app.lifecycle.{verb} ({outcome}): {ex.GetType().Name}");
        }
    }
}

// Covers both authenticated HTTP clients (including Shell) and the CLI's local control routes.
// This observes authorization failures as well as actions; it never replaces an authorization gate.
internal sealed class LifecycleAuditFilter(AuditStore audit, IClock clock, UserDirectoryStore users) : IEndpointFilter
{
    // Routing accepts equivalent casing and trailing slashes. Audit the matched contract, not
    // the caller's spelling, so those requests cannot silently skip or rename an audit event.
    private static string? ResolveVerb(HttpContext context)
        => (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText?.Split('/').LastOrDefault();

    internal static async Task RecordEarlyRefusalAsync(HttpContext context, RequestDelegate next)
    {
        await next(context);
        // App management can refuse before endpoint filters run. No authenticated principal was
        // handed to the endpoint in that case, so record the refusal without inventing an actor.
        if (context.GetEndpoint()?.Metadata.GetMetadata<LifecycleAuditMarker>() is not null &&
            LifecycleAuditOperation.Current(context.Request) is null && context.Response.StatusCode is 401 or 403 &&
            context.Request.RouteValues["appId"] is string appId && ResolveVerb(context) is string verb)
        {
            var operation = new LifecycleAuditOperation(appId, verb, null, "http");
            await operation.WriteAsync(context.RequestServices.GetRequiredService<AuditStore>(),
                context.RequestServices.GetRequiredService<IClock>(), "refused");
        }
    }

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var request = context.HttpContext.Request;
        var verb = ResolveVerb(context.HttpContext);
        if (!HttpMethods.IsPost(request.Method) || request.RouteValues["appId"] is not string appId ||
            verb is not ("start" or "stop" or "restart" or "update" or "autostart" or "switch-runtime" or "configure"))
            return await next(context);

        var control = request.Path.StartsWithSegments("/control");
        string? actor = null;
        if (!control)
        {
            try { actor = (await CoreSessionAuthorization.TryResolveSessionAsync(request, users, clock, request.HttpContext.RequestAborted))?.Id; }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                Console.Error.WriteLine($"[audit] Could not resolve lifecycle actor: {ex.GetType().Name}");
            }
        }

        // Local control authenticates a host secret, not a Host user. Null is honest attribution.
        var operation = new LifecycleAuditOperation(appId, verb, actor, control ? "control" : "http");
        operation.Attach(context.HttpContext);
        var outcome = "failed";
        try
        {
            var result = await next(context);
            var status = (result as IStatusCodeHttpResult)?.StatusCode ?? StatusCodes.Status200OK;
            outcome = status is 401 or 403 ? "refused" : status >= 400 ? "failed" : "succeeded";
            if (result is IValueHttpResult { Value: AppLifecycleResponse { Status: "restarting" or "updating" } })
                outcome = "accepted";
            return result;
        }
        catch (OperationCanceledException)
        {
            outcome = "cancelled";
            throw;
        }
        finally
        {
            // Enqueue owns accepted + terminal records, ordered before/after the detached work.
            if (!operation.Accepted) await operation.WriteAsync(audit, clock, outcome);
        }
    }
}

internal sealed record LifecycleAuditMarker;
