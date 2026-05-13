namespace Haas.DockerHost.Cli.Commands;

using System.Net;
using System.Net.Sockets;

internal static class PortAllocator
{
    public static int GetFreeLoopbackPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            return ((IPEndPoint)listener.LocalEndpoint).Port;
        }
        finally
        {
            listener.Stop();
        }
    }
}

