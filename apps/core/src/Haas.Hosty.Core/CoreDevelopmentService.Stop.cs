using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

internal sealed record CoreStopRequest(string Instance);
internal sealed record CoreStopResponse(string Status, string Instance, bool KeepApps);

internal sealed partial class CoreDevelopmentService
{
    // The caller owns this admission until shutdown completes. The same cross-process lease guards
    // source changes, restarts and workspace handovers, including operations launched by the CLI.
    internal async Task<IDisposable> PrepareStopAsync(CoreStopRequest request, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Instance)) throw new ArgumentException("The current Core instance is required.");
        if (!await gate.WaitAsync(0, cancellationToken))
            throw new AppLifecycleException("core_operation_in_progress", "Another Core operation is in progress; wait for it before stopping.");
        FileStream? admission = null;
        try
        {
            if (request.Instance != Instance)
                throw new AppLifecycleException("core_instance_changed", "Core changed; refresh before stopping.");
            try
            {
                admission = CoreLaunchFiles.Lock(config.DataRoot);
                CheckBusy();
            }
            catch (Exception ex) when (ex is IOException or InvalidOperationException)
            {
                throw new AppLifecycleException("core_operation_in_progress", "A Core restart, source change or workspace operation must finish before stopping. " + ex.Message);
            }
            cancellationToken.ThrowIfCancellationRequested();
            return admission;
        }
        catch
        {
            admission?.Dispose();
            throw;
        }
        finally { gate.Release(); }
    }
}

// Acceptance is not exit proof. Flush the response before signalling shutdown, and retain admission
// until the host has stopped so another launch cannot enter while this Core is still shutting down.
internal sealed class CoreStopAcceptedResult(CoreStopResponse response, IDisposable admission,
    CoreShutdownOptions shutdownOptions, IHostApplicationLifetime lifetime) : IResult
{
    public async Task ExecuteAsync(HttpContext context)
    {
        try
        {
            await CoreJson.Json(response, statusCode: StatusCodes.Status202Accepted).ExecuteAsync(context);
            context.Response.OnCompleted(() =>
            {
                shutdownOptions.KeepRuntimeApps = true;
                lifetime.ApplicationStopped.Register(admission.Dispose);
                lifetime.StopApplication();
                return Task.CompletedTask;
            });
        }
        catch
        {
            admission.Dispose();
            throw;
        }
    }
}
