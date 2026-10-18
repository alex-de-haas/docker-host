using System.Buffers.Binary;

namespace Haas.Hosty.Core;

internal static class AppCreationIcon
{
    internal const int MaxBytes = 128 * 1024;
    internal const int MaxDimension = 1024;

    internal static byte[]? Read(string? encoded)
    {
        if (encoded is null) return null;
        if (encoded.Length > ((MaxBytes + 2) / 3) * 4) throw Invalid();
        byte[] bytes;
        try { bytes = Convert.FromBase64String(encoded); }
        catch (FormatException) { throw Invalid(); }
        if (bytes.Length > MaxBytes || bytes.Length < 57
            || !bytes.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })) throw Invalid();
        var offset = 8;
        var hasData = false;
        while (offset <= bytes.Length - 12)
        {
            var length = BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(offset, 4));
            if (length > bytes.Length - offset - 12) throw Invalid();
            var type = bytes.AsSpan(offset + 4, 4);
            var data = bytes.AsSpan(offset + 8, (int)length);
            // Verify complete chunks, including their CRC, before persisting an uploaded asset.
            uint crc = uint.MaxValue;
            foreach (var value in bytes.AsSpan(offset + 4, (int)length + 4))
            {
                crc ^= value;
                for (var bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ ((crc & 1) == 0 ? 0 : 0xedb88320u);
            }
            if (~crc != BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(offset + 8 + (int)length, 4))) throw Invalid();
            if (offset == 8)
            {
                if (!type.SequenceEqual("IHDR"u8) || length != 13) throw Invalid();
                var width = BinaryPrimitives.ReadUInt32BigEndian(data[..4]);
                var height = BinaryPrimitives.ReadUInt32BigEndian(data.Slice(4, 4));
                if (width is 0 or > MaxDimension || height is 0 or > MaxDimension) throw Invalid();
            }
            else if (type.SequenceEqual("IHDR"u8)) throw Invalid();
            if (type.SequenceEqual("IDAT"u8)) hasData = true;
            offset += (int)length + 12;
            if (type.SequenceEqual("IEND"u8))
            {
                if (length != 0 || !hasData || offset != bytes.Length) throw Invalid();
                return bytes;
            }
        }
        throw Invalid();
    }

    private static AppLifecycleException Invalid() => new("creation_icon_invalid",
        "Choose a PNG icon up to 128 KiB and 1024×1024 pixels.");
}
