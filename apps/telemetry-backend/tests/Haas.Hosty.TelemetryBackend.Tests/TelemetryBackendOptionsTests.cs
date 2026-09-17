using Xunit;
using Haas.Hosty.TelemetryBackend;

namespace Haas.Hosty.TelemetryBackend.Tests;

[CollectionDefinition("Options environment", DisableParallelization = true)]
public sealed class OptionsEnvironmentCollection;

[Collection("Options environment")]
public sealed class TelemetryBackendOptionsTests
{
    [Theory]
    [InlineData(null, null, 8080)]
    [InlineData("1", null, 34567)]
    [InlineData(null, "9090", 9090)]
    [InlineData("1", "9090", 9090)]
    public void QueryPort_UsesAssignedHostPortOnlyForLocalDevelopment(string? loopback, string? explicitPort, int expected)
    {
        string[] keys = ["HOSTY_TELEMETRY_BIND_LOOPBACK", "HOSTY_TELEMETRY_QUERY_PORT", "HOSTY_PORT_QUERY"];
        var original = keys.Select(Environment.GetEnvironmentVariable).ToArray();
        try
        {
            Environment.SetEnvironmentVariable(keys[0], loopback);
            Environment.SetEnvironmentVariable(keys[1], explicitPort);
            Environment.SetEnvironmentVariable(keys[2], "34567");
            Assert.Equal(expected, TelemetryBackendOptions.FromEnvironment().QueryPort);
        }
        finally
        {
            for (var i = 0; i < keys.Length; i++) Environment.SetEnvironmentVariable(keys[i], original[i]);
        }
    }
}
