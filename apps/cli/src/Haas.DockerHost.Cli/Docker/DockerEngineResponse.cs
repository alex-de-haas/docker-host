namespace Haas.DockerHost.Cli.Docker;

using System.Net;

internal sealed record DockerEngineResponse(
    string Operation,
    HttpStatusCode StatusCode,
    string Body,
    byte[] BodyBytes,
    IReadOnlyDictionary<string, IReadOnlyList<string>> Headers)
{
    public bool IsSuccess => (int)StatusCode is >= 200 and <= 299;
}
