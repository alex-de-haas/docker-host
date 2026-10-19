using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class SharedReceiptSharingTests : IDisposable
{
    private readonly string root = Directory.CreateTempSubdirectory("hosty-receipt-sharing-").FullName;
    private string PathForReceipt => Path.Combine(root, "receipt.json");
    private static readonly CoreSourceSettings Previous = new(null, "previous");
    private static readonly CoreSourceSettings Next = new(null, "next");
    private void Write(CoreSourceSettings receipt) => CoreLaunchFiles.Write(PathForReceipt, receipt, CoreLaunchJson.Default.CoreSourceSettings);
    private CoreSourceSettings? Read() => CoreLaunchFiles.Read(PathForReceipt, CoreLaunchJson.Default.CoreSourceSettings);
    private void AssertNoTemporaryFiles() => Assert.Empty(Directory.EnumerateFiles(root, "*.tmp"));

    [Fact]
    public async Task SharedReader_AllowsAtomicReplacementAndRetainsItsOriginalSnapshot()
    {
        Write(Previous);
        var reading = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var type = JsonMetadataServices.CreateValueInfo<CoreSourceSettings>(
            new JsonSerializerOptions { TypeInfoResolver = CoreLaunchJson.Default }, new PausedReader(reading, release));
        var reader = Task.Run(() => CoreLaunchFiles.Read(PathForReceipt, type));
        try
        {
            var started = await Task.WhenAny(reading.Task, reader).WaitAsync(TimeSpan.FromSeconds(10));
            if (started == reader)
            {
                await reader; // Surface configuration/read failures before waiting for the converter.
                Assert.Fail("The receipt reader completed without invoking its converter.");
            }
            await Task.Run(() => Write(Next)).WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(Next, Read());
        }
        finally { release.Set(); }
        Assert.Equal(Previous, await reader.WaitAsync(TimeSpan.FromSeconds(5)));
        AssertNoTemporaryFiles();
    }

    [Fact]
    public async Task WindowsLegacyReader_ReplacementRetriesUntilItsHandleCloses()
    {
        if (!OperatingSystem.IsWindows()) return;
        Write(Previous);
        using var legacy = new FileStream(PathForReceipt, FileMode.Open, FileAccess.Read, FileShare.Read);
        var writing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var writer = Task.Run(() => { writing.SetResult(); Write(Next); });
        try
        {
            await writing.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await Task.Delay(150);
            Assert.False(writer.IsCompleted, "Atomic replacement must wait for the non-delete-sharing reader.");
        }
        finally
        {
            legacy.Dispose();
            await writer.WaitAsync(TimeSpan.FromSeconds(5));
        }
        Assert.Equal(Next, Read());
        AssertNoTemporaryFiles();
    }

    [Fact]
    public void WindowsPersistentLegacyReader_ReplacementFailsWithinBoundAndPreservesReceipt()
    {
        if (!OperatingSystem.IsWindows()) return;
        Write(Previous);
        var original = File.ReadAllBytes(PathForReceipt);
        using var legacy = new FileStream(PathForReceipt, FileMode.Open, FileAccess.Read, FileShare.Read);
        var elapsed = Stopwatch.StartNew();

        var error = Assert.Throws<IOException>(() => Write(Next));

        Assert.Contains(error.HResult & 0xffff, new[] { 32, 33 });
        Assert.InRange(elapsed.Elapsed.TotalSeconds, 1.5, 10);
        Assert.Equal(original, File.ReadAllBytes(PathForReceipt));
        Assert.Equal(Previous, Read());
        AssertNoTemporaryFiles();
    }

    [Fact]
    public void WindowsReadOnlyReceipt_AccessDenialIsNotRetriedAndPreservesReceipt()
    {
        if (!OperatingSystem.IsWindows()) return;
        Write(Previous);
        var original = File.ReadAllBytes(PathForReceipt);
        File.SetAttributes(PathForReceipt, FileAttributes.ReadOnly);
        try
        {
            var elapsed = Stopwatch.StartNew();
            var error = Assert.Throws<UnauthorizedAccessException>(() => Write(Next));
            Assert.Equal(5, error.HResult & 0xffff);
            Assert.True(elapsed.Elapsed < TimeSpan.FromSeconds(1), "ACL/access errors must not enter the sharing retry window.");
            Assert.Equal(original, File.ReadAllBytes(PathForReceipt));
            AssertNoTemporaryFiles();
        }
        finally { File.SetAttributes(PathForReceipt, FileAttributes.Normal); }
    }

    private sealed class PausedReader(TaskCompletionSource reading, ManualResetEventSlim release) : JsonConverter<CoreSourceSettings>
    {
        public override CoreSourceSettings? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            reading.TrySetResult();
            if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("The test did not release the receipt reader.");
            return JsonSerializer.Deserialize(ref reader, CoreLaunchJson.Default.CoreSourceSettings);
        }
        public override void Write(Utf8JsonWriter writer, CoreSourceSettings value, JsonSerializerOptions options) => throw new NotSupportedException();
    }

    public void Dispose() => Directory.Delete(root, true);
}
