using System.Buffers;
using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

// One place for comparing a caller-submitted secret against the expected value, so no endpoint
// reaches for string.Equals on a credential. Ordinary string equality returns on the first differing
// character, which makes the comparison time a function of how much of the secret the caller guessed.
internal static class SecretComparison
{
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

        return CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(expected),
            Encoding.UTF8.GetBytes(submitted));
    }

    private static bool TryDecodeHex(string value, Span<byte> destination)
        => value.Length == destination.Length * 2 &&
            Convert.FromHexString(value, destination, out _, out var written) == OperationStatus.Done &&
            written == destination.Length;
}
