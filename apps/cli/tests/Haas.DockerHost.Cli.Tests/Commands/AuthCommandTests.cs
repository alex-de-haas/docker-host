using System.Text.Json;
using Haas.DockerHost.Cli;

namespace Haas.DockerHost.Cli.Tests.Commands;

public sealed class AuthCommandTests : IDisposable
{
    private const string RootVariable = "DOCKER_HOST_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public AuthCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"docker-host-auth-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public async Task RunAsync_RecoveryToken_CreatesRecoveryTokenAndAuditEvent()
    {
        var exitCode = await CommandLine.RunAsync(["auth", "recovery-token"]);

        Assert.Equal(0, exitCode);

        var statePath = Path.Combine(rootDirectory, "auth", "state.json");
        using var state = JsonDocument.Parse(await File.ReadAllTextAsync(statePath));
        var tokenRecord = state.RootElement.GetProperty("setupTokens")[0];

        Assert.Equal("recovery", tokenRecord.GetProperty("purpose").GetString());
        Assert.StartsWith("setup_", tokenRecord.GetProperty("id").GetString());
        Assert.False(string.IsNullOrWhiteSpace(tokenRecord.GetProperty("tokenHash").GetString()));

        var audit = await File.ReadAllTextAsync(Path.Combine(rootDirectory, "auth", "audit.ndjson"));
        Assert.Contains("auth.recovery_token.created", audit);
        Assert.DoesNotContain("dhstp_", audit);
    }

    [Fact]
    public async Task RunAsync_RecoveryToken_RemovesStaleAuthStateLock()
    {
        var authRoot = Path.Combine(rootDirectory, "auth");
        Directory.CreateDirectory(authRoot);
        var lockPath = Path.Combine(authRoot, "state.json.lock");
        await File.WriteAllTextAsync(lockPath, "stale");
        File.SetLastWriteTimeUtc(lockPath, DateTime.UtcNow.AddMinutes(-5));

        var exitCode = await CommandLine.RunAsync(["auth", "recovery-token"]);

        Assert.Equal(0, exitCode);
        Assert.False(File.Exists(lockPath));
    }

    [Fact]
    public async Task RunAsync_RecoveryToken_WhenAuthRootCannotBeCreated_ReturnsConfigurationError()
    {
        Directory.CreateDirectory(rootDirectory);
        await File.WriteAllTextAsync(Path.Combine(rootDirectory, "auth"), "not a directory");

        var exitCode = await CommandLine.RunAsync(["auth", "recovery-token"]);

        Assert.Equal(2, exitCode);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(RootVariable, previousRoot);

        if (Directory.Exists(rootDirectory))
        {
            Directory.Delete(rootDirectory, recursive: true);
        }
    }
}
