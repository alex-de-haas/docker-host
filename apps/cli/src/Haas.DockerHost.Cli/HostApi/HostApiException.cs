namespace Haas.DockerHost.Cli.HostApi;

using System.Net;

internal sealed class HostApiException(
    string operation,
    string message,
    HttpStatusCode? statusCode = null,
    string? responseBody = null,
    string? nextStep = null,
    Exception? innerException = null)
    : Exception(message, innerException)
{
    public string Operation { get; } = operation;

    public HttpStatusCode? StatusCode { get; } = statusCode;

    public string? ResponseBody { get; } = responseBody;

    public string? NextStep { get; } = nextStep;
}
