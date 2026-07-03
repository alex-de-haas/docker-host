using System.Text;
using Xunit;
using Haas.Hosty.TelemetryBackend;

namespace Haas.Hosty.TelemetryBackend.Tests;

public sealed class FileTailReaderTests : IDisposable
{
    private readonly string path = Path.Combine(Path.GetTempPath(), $"hosty-otlp-logs-{Guid.NewGuid():N}.jsonl");
    private readonly FileTailReader reader = new();

    [Fact]
    public async Task ReadAsync_ReturnsNullWhenFileMissing()
        => Assert.Null(await reader.ReadAsync(path, 0));

    [Fact]
    public async Task ReadAsync_ReadsCompleteLinesAndLeavesTrailingPartial()
    {
        await File.WriteAllTextAsync(path, "line one\nline two\npartial");

        var read = Assert.NotNull(await reader.ReadAsync(path, 0));

        Assert.Equal("line one\nline two\n", read.Content);
        // The offset stops before the trailing partial so it is re-read once completed.
        Assert.Equal(Encoding.UTF8.GetByteCount("line one\nline two\n"), read.NextOffset);
    }

    [Fact]
    public async Task ReadAsync_ResumesFromOffsetReadingOnlyNewContent()
    {
        await File.WriteAllTextAsync(path, "first\n");
        var first = Assert.NotNull(await reader.ReadAsync(path, 0));

        await File.AppendAllTextAsync(path, "second\n");
        var second = Assert.NotNull(await reader.ReadAsync(path, first.NextOffset));

        Assert.Equal("second\n", second.Content);
    }

    [Fact]
    public async Task ReadAsync_ResetsToStartWhenFileShrank()
    {
        // Simulate rotation: caller's offset is past the (new, smaller) file length.
        await File.WriteAllTextAsync(path, "fresh\n");

        var read = Assert.NotNull(await reader.ReadAsync(path, fromOffset: 9999));

        Assert.Equal("fresh\n", read.Content);
        Assert.Equal(Encoding.UTF8.GetByteCount("fresh\n"), read.NextOffset);
    }

    [Fact]
    public async Task ReadAsync_ReturnsEmptyAndHoldsOffsetWhenOnlyPartialLine()
    {
        await File.WriteAllTextAsync(path, "no newline yet");

        var read = Assert.NotNull(await reader.ReadAsync(path, 0));

        Assert.Equal(string.Empty, read.Content);
        Assert.Equal(0, read.NextOffset);
    }

    [Fact]
    public async Task ReadAsync_ReturnsEmptyWhenNothingNew()
    {
        await File.WriteAllTextAsync(path, "done\n");
        var length = Encoding.UTF8.GetByteCount("done\n");

        var read = Assert.NotNull(await reader.ReadAsync(path, fromOffset: length));

        Assert.Equal(string.Empty, read.Content);
        Assert.Equal(length, read.NextOffset);
    }

    public void Dispose()
    {
        if (File.Exists(path))
        {
            File.Delete(path);
        }
    }
}
