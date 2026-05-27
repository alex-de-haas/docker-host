namespace Haas.DockerHost.Cli.Commands;

using System.Net;
using System.Net.Sockets;
using System.Text;

internal sealed class LocalMetadataFileServer : IAsyncDisposable
{
    private readonly string metadataFilePath;
    private readonly TcpListener listener;
    private readonly CancellationTokenSource cancellation = new();
    private readonly Task acceptLoop;
    private readonly Action<Exception>? onClientError;
    private readonly byte[]? metadataBytes;

    private LocalMetadataFileServer(
        string metadataFilePath,
        TcpListener listener,
        string publicUrl,
        Action<Exception>? onClientError,
        byte[]? metadataBytes)
    {
        this.metadataFilePath = metadataFilePath;
        this.listener = listener;
        this.onClientError = onClientError;
        this.metadataBytes = metadataBytes;
        PublicUrl = publicUrl;
        acceptLoop = AcceptLoopAsync();
    }

    public string PublicUrl { get; }

    public static LocalMetadataFileServer Start(
        string metadataFilePath,
        string publicHost,
        Action<Exception>? onClientError = null,
        byte[]? metadataBytes = null)
    {
        if (!File.Exists(metadataFilePath))
        {
            throw new CommandUsageException($"Metadata file was not found: {metadataFilePath}", DevCommand.Usage);
        }

        var listener = new TcpListener(IPAddress.Any, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var host = string.IsNullOrWhiteSpace(publicHost) ? "host.docker.internal" : publicHost.Trim();
        var publicUrl = $"http://{host}:{port}/metadata.json";
        return new LocalMetadataFileServer(metadataFilePath, listener, publicUrl, onClientError, metadataBytes);
    }

    public async ValueTask DisposeAsync()
    {
        cancellation.Cancel();
        listener.Stop();

        try
        {
            await acceptLoop.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
        catch (ObjectDisposedException)
        {
        }

        cancellation.Dispose();
    }

    private async Task AcceptLoopAsync()
    {
        while (!cancellation.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await listener.AcceptTcpClientAsync(cancellation.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }

            _ = Task.Run(async () =>
            {
                try
                {
                    await HandleClientAsync(client).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
                {
                }
                catch (ObjectDisposedException) when (cancellation.IsCancellationRequested)
                {
                }
                catch (Exception ex)
                {
                    ReportClientError(ex);
                }
            });
        }
    }

    private async Task HandleClientAsync(TcpClient client)
    {
        using var _ = client;
        using var stream = client.GetStream();

        var buffer = new byte[4096];
        var read = await stream.ReadAsync(buffer, cancellation.Token).ConfigureAwait(false);
        if (read == 0)
        {
            return;
        }

        var requestLine = Encoding.ASCII.GetString(buffer, 0, read).Split("\r\n", StringSplitOptions.None)[0];
        var path = requestLine.Split(' ', StringSplitOptions.RemoveEmptyEntries).ElementAtOrDefault(1) ?? "/";

        if (path is not "/" and not "/metadata.json")
        {
            await WriteResponseAsync(stream, "404 Not Found", "text/plain", Encoding.UTF8.GetBytes("Not found")).ConfigureAwait(false);
            return;
        }

        var bytes = metadataBytes ?? await File.ReadAllBytesAsync(metadataFilePath, cancellation.Token).ConfigureAwait(false);
        await WriteResponseAsync(stream, "200 OK", "application/json", bytes).ConfigureAwait(false);
    }

    private void ReportClientError(Exception ex)
    {
        try
        {
            onClientError?.Invoke(ex);
        }
        catch
        {
        }
    }

    private static async Task WriteResponseAsync(Stream stream, string status, string contentType, byte[] body)
    {
        var header = Encoding.ASCII.GetBytes(
            $"HTTP/1.1 {status}\r\nContent-Type: {contentType}\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(header).ConfigureAwait(false);
        await stream.WriteAsync(body).ConfigureAwait(false);
    }
}
