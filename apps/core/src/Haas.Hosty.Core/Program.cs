using System.Net.Sockets;
using Haas.Hosty.Core;

// Hidden re-exec: Core spawns localCommand roots by re-execing itself as a setsid process-group
// leader (see LocalCommandShim) so a later Core can reclaim the whole tree by process group.
if (args.Length >= 2 && args[0] == LocalCommandShim.Verb)
{
    return await LocalCommandShim.RunAsync(args);
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
