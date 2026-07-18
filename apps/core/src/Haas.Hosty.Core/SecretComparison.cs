using System.Buffers;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace Haas.Hosty.Core;

// One place for comparing a caller-submitted secret against the expected value, so no endpoint
// reaches for string.Equals on a credential. Ordinary string equality returns on the first differing
// character, which makes the comparison time a function of how much of the secret the caller guessed.
internal static class SecretComparison
{
    // 256 bytes of hex. Far above the 64-char secrets Core mints, low enough to keep the stack
    // allocation below bounded by a constant.
    private const int MaxHexLength = 512;


    // For fixed-length hex credentials (Core mints these as 32 random bytes rendered as 64 hex
    // chars). Both sides are decoded before comparison so the comparison runs over the same 32-byte
    // shape regardless of what the caller submitted; a value that is not well-formed hex of the
    // expected length cannot match and is rejected without inspecting the secret.
    public static bool HexEquals(string? expected, string? submitted)
    {
        if (string.IsNullOrEmpty(expected) || string.IsNullOrEmpty(submitted))
        {
            return false;
        }

        // The stack buffers are sized from `expected`, which is Core-minted and 64 chars today — not
        // from caller input, so this is not attacker-controlled. The bound keeps that safety local to
        // this method instead of resting on a caller invariant a future caller might not know about.
        if (expected.Length > MaxHexLength)
        {
            return false;
        }

        Span<byte> expectedBytes = stackalloc byte[expected.Length / 2];
        Span<byte> submittedBytes = stackalloc byte[expected.Length / 2];
        if (!TryDecodeHex(expected, expectedBytes) || !TryDecodeHex(submitted, submittedBytes))
        {
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(expectedBytes, submittedBytes);
    }

    // For opaque secrets with no guaranteed encoding (operator-supplied values such as the trusted
    // proxy secret). FixedTimeEquals short-circuits on differing lengths, so this leaks the length
    // but not the content.
    public static bool Equals(string? expected, string? submitted)
    {
        if (string.IsNullOrEmpty(expected) || string.IsNullOrEmpty(submitted))
        {
            return false;
        }

        // MemoryMarshal over the UTF-16 storage rather than Encoding.UTF8.GetBytes: equal strings have
        // equal UTF-16, so the comparison is unchanged, and it avoids copying the secret onto the heap
        // where it would linger in two byte[] until collected.
        return CryptographicOperations.FixedTimeEquals(
            MemoryMarshal.AsBytes(expected.AsSpan()),
            MemoryMarshal.AsBytes(submitted.AsSpan()));
    }

    private static bool TryDecodeHex(string value, Span<byte> destination)
        => value.Length == destination.Length * 2 &&
            Convert.FromHexString(value, destination, out _, out var written) == OperationStatus.Done &&
            written == destination.Length;
}
