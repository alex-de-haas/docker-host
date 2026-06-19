using System.Net.Sockets;
using Haas.Hosty.Core;

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
catch (IOException ex) when (IsAddressInUse(ex))
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
