using Haas.Hosty.Cli.Commands;

namespace Haas.Hosty.Cli.Tests;

// A background start redirects Core's stdout into core.log with `>`, which truncates. The run that
// just crashed was therefore erased by the restart that followed it — the defect these tests pin
// (L-L3 in the 2026-07-05 review), reproduced in the wild on 2026-08-19 when a Core update took 28
// hours of history with it.
public sealed class CoreLogRotationTests : IDisposable
{
    private readonly string directory = Path.Combine(
        Path.GetTempPath(),
        $"hosty-core-log-rotation-{Guid.NewGuid():N}");

    public CoreLogRotationTests() => Directory.CreateDirectory(directory);

    public void Dispose()
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private string LogPath => Path.Combine(directory, "core.log");

    [Fact]
    public void Rotate_MovesTheCurrentLogAside()
    {
        File.WriteAllText(LogPath, "first run");

        CoreCommand.RotateCoreLog(LogPath);

        Assert.False(File.Exists(LogPath));
        Assert.Equal("first run", File.ReadAllText($"{LogPath}.1"));
    }

    [Fact]
    public void Rotate_ShiftsOlderGenerationsDown()
    {
        File.WriteAllText(LogPath, "run 1");
        CoreCommand.RotateCoreLog(LogPath);
        File.WriteAllText(LogPath, "run 2");
        CoreCommand.RotateCoreLog(LogPath);
        File.WriteAllText(LogPath, "run 3");
        CoreCommand.RotateCoreLog(LogPath);

        Assert.Equal("run 3", File.ReadAllText($"{LogPath}.1"));
        Assert.Equal("run 2", File.ReadAllText($"{LogPath}.2"));
        Assert.Equal("run 1", File.ReadAllText($"{LogPath}.3"));
    }

    [Fact]
    public void Rotate_DropsTheOldestGenerationPastTheCap()
    {
        for (var run = 1; run <= 5; run++)
        {
            File.WriteAllText(LogPath, $"run {run}");
            CoreCommand.RotateCoreLog(LogPath);
        }

        Assert.Equal("run 5", File.ReadAllText($"{LogPath}.1"));
        Assert.Equal("run 3", File.ReadAllText($"{LogPath}.3"));
        Assert.False(File.Exists($"{LogPath}.4"));
    }

    // A first start has nothing to rotate, and rotation must never be the reason Core does not start.
    [Fact]
    public void Rotate_IsAQuietNoOpWhenThereIsNoLogYet()
    {
        CoreCommand.RotateCoreLog(LogPath);

        Assert.False(File.Exists($"{LogPath}.1"));
    }
}
