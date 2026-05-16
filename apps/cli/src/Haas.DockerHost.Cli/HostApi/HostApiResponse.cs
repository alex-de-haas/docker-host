namespace Haas.DockerHost.Cli.HostApi;

using System.Net;

internal sealed record HostApiResponse<T>(
    HttpStatusCode StatusCode,
    T? Body,
    string RawBody)
{
    public bool IsSuccess => (int)StatusCode >= 200 && (int)StatusCode < 300;
}
