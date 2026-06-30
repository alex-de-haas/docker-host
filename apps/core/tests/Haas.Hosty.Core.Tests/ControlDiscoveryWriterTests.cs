namespace Haas.Hosty.Core.Tests;

public sealed class ControlDiscoveryWriterTests : IDisposable
{
    private readonly string directory = Path.Combine(
        Path.GetTempPath(),
        $"hosty-control-discovery-tests-{Guid.NewGuid():N}");

    public ControlDiscoveryWriterTests() => Directory.CreateDirectory(directory);

    public void Dispose()
    {
        if (Directory.Exists(directory))
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void OwnsDiscoveryFile_MatchingNonce_ReturnsTrue()
    {
        var path = WriteDiscovery("nonce-a");

        Assert.True(ControlDiscoveryWriter.OwnsDiscoveryFile(path, "nonce-a"));
    }

    [Fact]
    public void OwnsDiscoveryFile_DifferentNonce_ReturnsFalse()
    {
        // Simulates a newer Core having overwritten control.json: the departing instance must not
        // delete a file it no longer owns.
        var path = WriteDiscovery("written-by-newer-core");

        Assert.False(ControlDiscoveryWriter.OwnsDiscoveryFile(path, "this-instance"));
    }

    [Fact]
    public void OwnsDiscoveryFile_MissingFile_ReturnsFalse()
        => Assert.False(ControlDiscoveryWriter.OwnsDiscoveryFile(Path.Combine(directory, "missing.json"), "any"));

    [Fact]
    public void OwnsDiscoveryFile_UnparseableFile_ReturnsFalse()
    {
        var path = Path.Combine(directory, "control.json");
        File.WriteAllText(path, "not json");

        Assert.False(ControlDiscoveryWriter.OwnsDiscoveryFile(path, "any"));
    }

    private string WriteDiscovery(string nonce)
    {
        var path = Path.Combine(directory, "control.json");
        File.WriteAllText(path, $$"""
            {
              "schemaVersion": 2,
              "component": "hosty-core",
              "transport": "http-loopback",
              "endpoint": "http://localhost:7070",
              "controlBaseUrl": "http://localhost:7070/control/v1",
              "requiredHeaders": { "X-Hosty-Control-Secret": "secret" },
              "startedAt": "2026-06-30T09:15:25+00:00",
              "processId": 4242,
              "nonce": "{{nonce}}"
            }
            """);
        return path;
    }
}
