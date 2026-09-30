using System.Buffers.Binary;

namespace Hosty.Whisper;

internal static class WaveAudio
{
    public const int MaxSeconds = 120;
    public const int MaxBytes = MaxSeconds * 16000 * 2 + 4096;

    public static async Task<float[]> ReadAsync(Stream input, CancellationToken ct)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        int count;
        while ((count = await input.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + count > MaxBytes) throw new InvalidDataException("The recording exceeds the two-minute input limit.");
            await buffer.WriteAsync(chunk.AsMemory(0, count), ct);
        }
        return Decode(buffer.ToArray());
    }
    internal static float[] Decode(ReadOnlySpan<byte> wave)
    {
        if (wave.Length < 44 || wave.Length > MaxBytes || !wave[..4].SequenceEqual("RIFF"u8) || !wave.Slice(8, 4).SequenceEqual("WAVE"u8)
            || BinaryPrimitives.ReadUInt32LittleEndian(wave[4..]) != wave.Length - 8)
            throw new InvalidDataException("Invalid WAV recording.");
        var format = false;
        ReadOnlySpan<byte> data = default;
        var at = 12;
        var hasData = false;
        for (; at + 8 <= wave.Length;)
        {
            var size = BinaryPrimitives.ReadUInt32LittleEndian(wave[(at + 4)..]);
            if (size > wave.Length - at - 8) throw new InvalidDataException("Truncated WAV recording.");
            var payload = wave.Slice(at + 8, (int)size);
            if (wave.Slice(at, 4).SequenceEqual("fmt "u8))
            {
                if (format || size < 16 || BinaryPrimitives.ReadUInt16LittleEndian(payload) != 1
                    || BinaryPrimitives.ReadUInt16LittleEndian(payload[2..]) != 1
                    || BinaryPrimitives.ReadUInt32LittleEndian(payload[4..]) != 16000
                    || BinaryPrimitives.ReadUInt32LittleEndian(payload[8..]) != 32000
                    || BinaryPrimitives.ReadUInt16LittleEndian(payload[12..]) != 2
                    || BinaryPrimitives.ReadUInt16LittleEndian(payload[14..]) != 16)
                    throw new InvalidDataException("Use 16 kHz mono PCM16 WAV audio.");
                format = true;
            }
            if (wave.Slice(at, 4).SequenceEqual("data"u8))
            {
                if (hasData) throw new InvalidDataException("Multiple WAV data chunks are unsupported.");
                data = payload;
                hasData = true;
            }
            at += 8 + (int)size + ((int)size & 1);
        }
        if (at != wave.Length || !format || data.IsEmpty || data.Length % 2 != 0 || data.Length / 2 > MaxSeconds * 16000)
            throw new InvalidDataException("Provide a nonempty recording of at most two minutes.");
        var samples = new float[data.Length / 2];
        for (var i = 0; i < samples.Length; i++) samples[i] = BinaryPrimitives.ReadInt16LittleEndian(data[(i * 2)..]) / 32768f;
        return samples;
    }
}
