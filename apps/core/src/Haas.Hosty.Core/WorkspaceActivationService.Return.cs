using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

internal sealed partial class WorkspaceActivationService
{
    internal async Task<WorkspaceRuntimeActivation> ValidateRuntimeAuthorityAsync(string id, CancellationToken ct)
    {
        var a = WorkspaceRuntimeFiles.Read(paths.DataRoot, id);
        if (a.Authority is not null)
            await (access ?? throw Error("authority_invalid", "Activation authority is unavailable.")).ValidateAsync(a.Authority,
                a.Phase.StartsWith("return-", StringComparison.Ordinal) ? a.Returns!.Last().Request.Core : a.CoreProject is not null && !a.CoreReturned, ct);
        return a;
    }

    internal async Task<WorkspaceRuntimeActivation> PrepareReturnAsync(string id, WorkspaceReturnRequest input, CancellationToken ct, WorkspaceActivationActor? actor = null)
    {
        await gate.WaitAsync(ct);
        try
        {
            using var admission = CoreLaunchFiles.Lock(paths.DataRoot);
            return WorkspaceActivationReturn.Prepare(paths.DataRoot, id, input, actor);
        }
        finally { gate.Release(); }
    }

    internal async Task<WorkspaceRuntimeActivation> ReturnAppsAsync(string id, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var a = WorkspaceRuntimeFiles.Read(paths.DataRoot, id);
            var receipt = a.Returns?.LastOrDefault() ?? throw Error("return_missing", "Prepare Return before applying it.");
            if (a.Authority is not null) await (access ?? throw Error("authority_invalid", "Return authority is unavailable.")).ValidateAsync(a.Authority, receipt.Request.Core, ct);
            if (receipt.State != "pending" || a.Phase != "return-apps") return a;
            return await lifecycle.WithActivationAppLocksAsync(receipt.Request.Apps.Order(StringComparer.Ordinal).ToArray(), async () =>
            {
                var failures = new List<string>();
                foreach (var app in a.Apps.Reverse().Where(receipt.Request.Apps.Contains))
                {
                    if ((a.ReturnedApps ?? []).Contains(app)) continue;
                    WorkspaceActivationSupervisor.CheckCancellation(paths.DataRoot, id);
                    try
                    {
                        await lifecycle.ReturnActivationAppAsync(a, app, receipt.Request, CancellationToken.None);
                        a = a with { ReturnedApps = [.. a.ReturnedApps ?? [], app] };
                        WorkspaceRuntimeFiles.Save(paths.DataRoot, a);
                    }
                    catch (Exception ex) when (ex is AppLifecycleException or IOException or InvalidOperationException)
                    { failures.Add(app + ": " + ex.Message); }
                }
                if (failures.Count != 0)
                {
                    a = a with { Error = "Return is partial. " + string.Join("; ", failures) };
                    WorkspaceRuntimeFiles.Save(paths.DataRoot, a);
                    throw Error("return_partial", a.Error);
                }
                WorkspaceRuntimeFiles.Save(paths.DataRoot, a with { Error = null });
                return a;
            }, ct);
        }
        finally { gate.Release(); }
    }
}
