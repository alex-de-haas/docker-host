using System.Net.Sockets;
using Haas.Hosty.Core;

// Hidden re-exec: Core spawns localCommand roots through itself before the platform shell. The shim
// becomes a POSIX process-group leader or joins a Windows kill-on-close job, so Core owns the whole
// descendant tree even when an intermediate shell/npm process exits (see LocalCommandShim).
if (args.Length >= 2 && args[0] == LocalCommandShim.Verb)
{
    return await LocalCommandShim.RunAsync(args);
}

// Before spawning any child (localCommand services, docker/git CLI, the detached CLI launcher), drop the
// inherit flag from Core's own stdio. The CLI runs Core with `> core.log 2>&1`, so those handles are the
// core.log file; a localCommand child that outlives Core would otherwise keep core.log open and wedge the
// next Core start's redirect. See WindowsProcessControl.
if (OperatingSystem.IsWindows())
{
    WindowsProcessControl.MakeStandardHandlesNonInheritable();
}

var builder = WebApplication.CreateSlimBuilder(args);
HostyCoreApplication.ConfigureServices(builder);

var app = builder.Build();
HostyCoreApplication.MapEndpoints(app);

// Resolve the listen URL before running: once RunAsync rethrows a startup failure the
// host (and its service provider) is already disposed, so we cannot reach DI from the
// catch block.
var listenUrl = app.Services.GetRequiredService<HostyCoreRuntimeConfig>().ListenUrl;

try
{
    await app.RunAsync();
}
catch (Exception ex) when (IsAddressInUse(ex))
{
    await Console.Error.WriteLineAsync(
        $"Hosty Core cannot bind {listenUrl}: another process is already listening on it. " +
        "Stop the existing Core with `hosty core stop` (or reclaim the port) before starting again.");
    return 1;
}

return 0;

static bool IsAddressInUse(Exception exception)
{
    for (var current = exception; current is not null; current = current.InnerException)
    {
        if (current is SocketException { SocketErrorCode: SocketError.AddressAlreadyInUse })
        {
            return true;
        }
    }

    return false;
}
