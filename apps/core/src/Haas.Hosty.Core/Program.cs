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

// Resolve the two process parameters (data root, port: flag → env → stored → default), then take
// the per-root exclusive lock BEFORE anything binds or touches the root's state. One Core process
// per data root: a second start against a live root — any port — is refused here by naming the live
// instance, whether it came through `hosty core start` (which preflights the same check) or a
// direct `dotnet run`. The instance id is loaded under the lock so first-start creation cannot race.
HostyCoreRuntimeConfig config;
CoreRootLock rootLock;
try
{
    config = HostyCoreRuntimeConfig.FromEnvironment(builder.Environment, args);
    rootLock = CoreRootLock.Acquire(config);
}
catch (CoreRootLockedException ex)
{
    await Console.Error.WriteLineAsync(ex.Message);
    return 1;
}

config = config with { InstanceId = CoreInstanceId.LoadOrCreate(config.DataRoot) };

HostyCoreApplication.ConfigureServices(builder, config);
// Registered for disposal with the host so the lock is held for the full process lifetime and
// released cleanly on shutdown (the OS releases it on any harder exit).
builder.Services.AddSingleton(_ => rootLock);

var app = builder.Build();
// Materialize the lock registration so the container tracks it for disposal — nothing else ever
// resolves it.
_ = app.Services.GetRequiredService<CoreRootLock>();
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
