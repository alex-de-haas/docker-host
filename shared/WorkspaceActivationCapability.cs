using System.Diagnostics;
using System.Security.Cryptography;

namespace Haas.Hosty.Launch;

internal enum WorkspaceActivationCompatibilityFailure { Unavailable, InspectionFailed, TimedOut, Unsupported, Changed }

// Only fixed, operator-facing reasons reach the helper receipt; probe output and arbitrary
// process exceptions remain in diagnostics rather than becoming product UI messages.
internal sealed class WorkspaceActivationCompatibilityException(WorkspaceActivationCompatibilityFailure failure) : IOException(
    (failure switch
    {
        WorkspaceActivationCompatibilityFailure.Unavailable => "The prepared executable is unavailable.",
        WorkspaceActivationCompatibilityFailure.InspectionFailed => "The prepared executable could not be inspected.",
        WorkspaceActivationCompatibilityFailure.TimedOut => "The capability check timed out.",
        WorkspaceActivationCompatibilityFailure.Unsupported => "The target Core does not support the workspace handover contract.",
        _ => "The prepared executable changed during its capability check."
    }) + " Update this workspace to a Core revision that supports direct workspace switching, then retry. This compatibility check did not stop Core or applications.");

internal static class WorkspaceActivationCapability
{
    internal const string Schema = "workspace-activation.2";
    internal const string Argument = "--workspace-activation-contract";

    // Old Core binaries ignore unknown switches. An impossible runtime root and invalid listener
    // make those versions fail before acquiring locks or starting services. Supporting binaries
    // answer this read-only probe before loading configuration or persistent state.
    internal static async Task RequireAsync(string executable, CancellationToken ct = default, TimeSpan? timeout = null)
    {
        if (!File.Exists(executable)) throw Unsupported(WorkspaceActivationCompatibilityFailure.Unavailable);
        var hash = Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(executable, ct)));
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add(Argument);
        start.Environment["HOSTY_DATA_ROOT"] = executable;
        start.Environment["HOSTY_CORE_PORT"] = "65536";
        using var process = Process.Start(start) ?? throw Unsupported(WorkspaceActivationCompatibilityFailure.InspectionFailed);
        var output = process.StandardOutput.ReadToEndAsync(ct);
        var errors = process.StandardError.ReadToEndAsync(ct);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(timeout ?? TimeSpan.FromSeconds(10));
        try { await process.WaitForExitAsync(deadline.Token); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync(CancellationToken.None);
            await Task.WhenAll(output, errors);
            throw Unsupported(WorkspaceActivationCompatibilityFailure.TimedOut);
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync(CancellationToken.None);
            throw;
        }
        _ = await errors;
        if (process.ExitCode != 0 || (await output).Trim() != Schema)
            throw Unsupported(WorkspaceActivationCompatibilityFailure.Unsupported);
        if (!File.Exists(executable) || Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(executable, ct))) != hash)
            throw Unsupported(WorkspaceActivationCompatibilityFailure.Changed);
    }

    private static WorkspaceActivationCompatibilityException Unsupported(WorkspaceActivationCompatibilityFailure failure) => new(failure);
}
