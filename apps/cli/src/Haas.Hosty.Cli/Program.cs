using Haas.Hosty.Cli;

// Before spawning any child (the detached Core start, helper shells), drop the inherit flag from the
// CLI's own stdio. Core's update/restart endpoints run this CLI with `> core-update.log 2>&1`, so those
// handles are that log file; a replacement Core (and the app trees it spawns) would otherwise inherit
// the handle and wedge every later update spawn's redirect. See WindowsProcessControl.
if (OperatingSystem.IsWindows())
{
    WindowsProcessControl.MakeStandardHandlesNonInheritable();
}

return await CommandLine.RunAsync(args);
