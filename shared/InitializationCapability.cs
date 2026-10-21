using System.Diagnostics;

namespace Haas.Hosty.Initialization;

internal static class InitializationCapability
{
    // Old Core versions ignore unknown switches. Give a probe an impossible data root (the
    // executable file itself) and an invalid port, so they fail before creating a runtime root.
    // New versions handle this read-only switch before configuration, locks and hosted services.
    public static async Task RequireAsync(string executable, CancellationToken ct = default)
    {
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add("--initialization-contract");
        start.Environment["HOSTY_DATA_ROOT"] = executable;
        start.Environment["HOSTY_CORE_PORT"] = "65536";
        using var process = Process.Start(start) ?? throw new IOException("Could not inspect the Core initialization contract.");
        var output = process.StandardOutput.ReadToEndAsync(ct);
        var errors = process.StandardError.ReadToEndAsync(ct);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException) { if (!process.HasExited) process.Kill(entireProcessTree: true); throw; }
        _ = await errors;
        if (process.ExitCode != 0 || (await output).Trim() != InitializationFiles.Schema)
            throw new IOException("This installed Core does not support hosty init. Run hosty update explicitly, then retry; existing data is preserved.");
    }
}
