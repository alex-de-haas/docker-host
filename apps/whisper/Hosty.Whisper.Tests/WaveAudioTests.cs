using System.Buffers.Binary;
using Hosty.Whisper;
using Xunit;
namespace Hosty.Whisper.Tests;
public sealed class WaveAudioTests
{
    [Fact]
    public void DecodesSignedPcmWithoutDroppingSamples()
    {
        var samples = WaveAudio.Decode(Wave());
        Assert.Equal(3, samples.Length); Assert.Equal(-1, samples[0]); Assert.Equal(0, samples[1]); Assert.InRange(samples[2], 0.999f, 1f);
    }
    [Theory]
    [InlineData(0, 0)] [InlineData(4, 0)] [InlineData(20, 3)] [InlineData(22, 2)] [InlineData(24, 1)] [InlineData(34, 24)] [InlineData(40, 255)]
    public void RejectsCorruptOrUnsupportedWaves(int offset, byte value)
    {
        var wave = Wave(); wave[offset] = value;
        Assert.Throws<InvalidDataException>(() => WaveAudio.Decode(wave));
    }
    [Fact]
    public async Task BoundsInputBeforeDecoding()
    {
        using var oversized = new MemoryStream(new byte[WaveAudio.MaxBytes + 1]);
        await Assert.ThrowsAsync<InvalidDataException>(() => WaveAudio.ReadAsync(oversized, default));
        using var cancelled = new MemoryStream(Wave()); using var cts = new CancellationTokenSource(); cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => WaveAudio.ReadAsync(cancelled, cts.Token));
    }
    private static byte[] Wave()
    {
        var bytes = new byte[50];
        "RIFF"u8.CopyTo(bytes); BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(4), 42); "WAVEfmt "u8.CopyTo(bytes.AsSpan(8));
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(16), 16); bytes[20] = 1; bytes[22] = 1;
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(24), 16000); BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(28), 32000);
        bytes[32] = 2; bytes[34] = 16; "data"u8.CopyTo(bytes.AsSpan(36)); bytes[40] = 6;
        BinaryPrimitives.WriteInt16LittleEndian(bytes.AsSpan(44), short.MinValue); BinaryPrimitives.WriteInt16LittleEndian(bytes.AsSpan(48), short.MaxValue);
        return bytes;
    }
}
