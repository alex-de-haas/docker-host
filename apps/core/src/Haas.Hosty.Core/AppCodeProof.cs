using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.WebUtilities;

namespace Haas.Hosty.Core;

internal static class AppCodeProof
{
    internal static void RequireChallenge(string? challenge, string? method)
    {
        if (!string.Equals(method, "S256", StringComparison.Ordinal) || !IsChallenge(challenge))
            throw new AppIdentityException("code_challenge_invalid", "A canonical SHA-256 code challenge and codeChallengeMethod=S256 are required.");
    }

    internal static bool IsVerifier(string? verifier)
        => verifier is { Length: >= 43 and <= 128 } && verifier.All(character =>
            character is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '-' or '.' or '_' or '~');

    internal static bool IsChallenge(string? challenge)
    {
        if (challenge is not { Length: 43 } || !challenge.All(character =>
                character is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '-' or '_')) return false;
        try
        {
            var digest = WebEncoders.Base64UrlDecode(challenge);
            return digest.Length == 32 && string.Equals(WebEncoders.Base64UrlEncode(digest), challenge, StringComparison.Ordinal);
        }
        catch (FormatException) { return false; }
    }

    internal static bool Matches(string? challenge, string? verifier)
        => IsChallenge(challenge) && IsVerifier(verifier) && CryptographicOperations.FixedTimeEquals(
            WebEncoders.Base64UrlDecode(challenge!), SHA256.HashData(Encoding.ASCII.GetBytes(verifier!)));
}
