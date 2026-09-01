using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreRootLockTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-root-lock-tests-{Guid.NewGuid():N}");

    private HostyCoreRuntimeConfig Config => new(
        DataRoot: root,
        RunDirectory: Path.Combine(root, "core", "run"),
        ControlDiscoveryPath: Path.Combine(root, "core", "run", "control.json"),
        CorePort: 7070,
        ListenUrl: "http://localhost:7070",
        CorePublicOrigin: null,
        RuntimePublicHost: "127.0.0.1",
        ShellSourceOverridePath: null,
        ShellAutostart: false);

    [Fact]
    public void Acquire_FreshRoot_TakesTheLockAndCreatesTheRunDirectory()
    {
        using var rootLock = CoreRootLock.Acquire(Config);

        Assert.True(File.Exists(rootLock.LockPath));
    }

    [Fact]
    public void Acquire_HeldRoot_IsRefusedOnAnyPort()
    {
        // Ports do not guard root exclusivity: the second config "listens" elsewhere but shares the
        // root, and must be refused all the same.
        using var rootLock = CoreRootLock.Acquire(Config);

        var second = Config with { CorePort = 9999, ListenUrl = "http://localhost:9999" };
        var exception = Assert.Throws<CoreRootLockedException>(() => CoreRootLock.Acquire(second));

        Assert.Contains(root, exception.Message);
        Assert.Contains("--data-root", exception.Message);
    }

    [Fact]
    public void Acquire_HeldRootWithLiveDiscovery_NamesTheLiveInstance()
    {
        using var rootLock = CoreRootLock.Acquire(Config);
        // The discovery file names THIS test process — a PID that is definitely alive — so the
        // refusal must identify the live instance rather than fall back to the bare lock message.
        Directory.CreateDirectory(Path.GetDirectoryName(Config.ControlDiscoveryPath)!);
        File.WriteAllText(
            Config.ControlDiscoveryPath,
            $$"""
            {
              "schemaVersion": 2,
              "component": "hosty-core",
              "transport": "http-loopback",
              "endpoint": "http://localhost:7070",
              "controlBaseUrl": "http://localhost:7070/control/v1",
              "requiredHeaders": {},
              "processId": {{Environment.ProcessId}},
              "nonce": "test"
            }
            """);

        var exception = Assert.Throws<CoreRootLockedException>(() => CoreRootLock.Acquire(Config));

        Assert.Contains("already running", exception.Message);
        Assert.Contains($"PID {Environment.ProcessId}", exception.Message);
        Assert.Contains("http://localhost:7070", exception.Message);
        Assert.Contains(root, exception.Message);
    }

    [Fact]
    public void Acquire_StaleDiscoveryWithDeadPid_DoesNotClaimALiveInstance()
    {
        using var rootLock = CoreRootLock.Acquire(Config);
        Directory.CreateDirectory(Path.GetDirectoryName(Config.ControlDiscoveryPath)!);
        File.WriteAllText(
            Config.ControlDiscoveryPath,
            $$"""
            {
              "endpoint": "http://localhost:7070",
              "controlBaseUrl": "http://localhost:7070/control/v1",
              "processId": {{int.MaxValue - 1}}
            }
            """);

        var exception = Assert.Throws<CoreRootLockedException>(() => CoreRootLock.Acquire(Config));

        // The lock is genuinely held (by this test), but the discovery names a dead PID — the
        // message must not present that dead process as the live instance.
        Assert.DoesNotContain("already running", exception.Message);
        Assert.Contains("holds the Hosty Core root lock", exception.Message);
    }

    [Fact]
    public void Acquire_AfterRelease_ReusesTheLockFile()
    {
        var first = CoreRootLock.Acquire(Config);
        first.Dispose();

        // The OS released the lock with the holder; the leftover file is reopened, not "recovered".
        using var second = CoreRootLock.Acquire(Config);

        Assert.True(File.Exists(second.LockPath));
    }

    public void Dispose()
    {
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
