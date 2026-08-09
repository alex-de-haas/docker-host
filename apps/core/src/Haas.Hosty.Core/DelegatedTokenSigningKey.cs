using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

// The durable ECDSA P-256 key pair behind delegated tokens (docs/features/ai-gateway/plan.md).
// Asymmetric, unlike AppServiceSigningKey's HMAC: the receiving app validates tokens locally with
// the public key Core injects into its environment (HOSTY_DELEGATED_TOKEN_PUBLIC_KEY), so the
// private key never leaves Core. Durable for the same reason as AppServiceSigningKey — the public
// key is baked into app environments at container/process creation, and a keep-apps light restart
// adopts those still-running apps: a per-process key would invalidate every token they receive
// until something recreated them.
internal sealed class DelegatedTokenSigningKey
{
    private readonly byte[] _privateKeyPkcs8;

    public DelegatedTokenSigningKey(byte[] privateKeyPkcs8)
    {
        _privateKeyPkcs8 = (byte[])privateKeyPkcs8.Clone();
        using var ecdsa = CreateEcdsa();
        PublicKeySpkiBase64 = Convert.ToBase64String(ecdsa.ExportSubjectPublicKeyInfo());
    }

    // Base64 of the SubjectPublicKeyInfo DER — the exact value injected into app environments and
    // consumed by the SDK validator (SPKI is what both node:crypto and WebCrypto import natively).
    public string PublicKeySpkiBase64 { get; }

    // IEEE P1363 (r||s) signature over SHA-256 — .NET's default ECDSA output and the format
    // WebCrypto and node:crypto (dsaEncoding "ieee-p1363") verify without transcoding.
    // A fresh ECDsa per call: instances are not thread-safe and token issuance is low-volume.
    public byte[] Sign(ReadOnlySpan<byte> data)
    {
        using var ecdsa = CreateEcdsa();
        return ecdsa.SignData(data.ToArray(), HashAlgorithmName.SHA256);
    }

    public bool Verify(ReadOnlySpan<byte> data, ReadOnlySpan<byte> signature)
    {
        using var ecdsa = CreateEcdsa();
        return ecdsa.VerifyData(data.ToArray(), signature.ToArray(), HashAlgorithmName.SHA256);
    }

    private ECDsa CreateEcdsa()
    {
        var ecdsa = ECDsa.Create();
        ecdsa.ImportPkcs8PrivateKey(_privateKeyPkcs8, out _);
        return ecdsa;
    }

    public static DelegatedTokenSigningKey LoadOrCreate(CoreDataPaths paths)
    {
        var path = Path.Combine(paths.AuthRoot, "delegated-token-signing.key");

        var existing = TryReadKey(path);
        if (existing is not null)
        {
            SecureFileSystem.TryRestrictFile(path);
            return new DelegatedTokenSigningKey(existing);
        }

        SecureFileSystem.EnsurePrivateDirectory(paths.AuthRoot);
        byte[] key;
        using (var ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP256))
        {
            key = ecdsa.ExportPkcs8PrivateKey();
        }

        // First use: publish the key via a unique temp file + atomic rename so the real path is
        // never observed empty or partially written. overwrite:false means we lose cleanly if
        // another writer wins the rename.
        if (TryWriteKey(path, key, overwrite: false))
        {
            return new DelegatedTokenSigningKey(key);
        }

        // Another writer created the file first; adopt its key.
        var winner = TryReadKey(path);
        if (winner is not null)
        {
            SecureFileSystem.TryRestrictFile(path);
            return new DelegatedTokenSigningKey(winner);
        }

        // The file exists but holds no valid key (e.g. an empty file left behind by an older
        // crash). Replace it atomically with a fresh key.
        if (TryWriteKey(path, key, overwrite: true))
        {
            return new DelegatedTokenSigningKey(key);
        }

        throw new IOException($"Delegated token signing key could not be initialized at '{path}'.");
    }

    private static byte[]? TryReadKey(string path)
    {
        try
        {
            var text = File.ReadAllText(path).Trim();
            if (text.Length == 0)
            {
                return null;
            }

            var key = Convert.FromBase64String(text);
            if (key.Length == 0)
            {
                return null;
            }

            // A stored key that no longer imports (truncated write, foreign content) reads as
            // absent so it is replaced atomically, never used to mint unverifiable tokens.
            using var ecdsa = ECDsa.Create();
            ecdsa.ImportPkcs8PrivateKey(key, out _);
            return key;
        }
        catch (Exception ex) when (ex is IOException or FormatException or CryptographicException)
        {
            // UnauthorizedAccessException deliberately propagates: an existing-but-unreadable key
            // file must fail loudly, because the create path could rename over it and silently
            // rotate the durable key.
            return null;
        }
    }

    private static bool TryWriteKey(string path, byte[] key, bool overwrite)
    {
        var tempPath = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            using (var stream = SecureFileSystem.CreatePrivateFile(tempPath, FileMode.CreateNew))
            {
                stream.Write(Encoding.UTF8.GetBytes(Convert.ToBase64String(key)));
            }

            File.Move(tempPath, path, overwrite);
            SecureFileSystem.TryRestrictFile(path);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // A lost race or a write the filesystem refuses reports as "did not win"; the caller
            // falls back to reading the winner.
            return false;
        }
        finally
        {
            TryDeleteFile(tempPath);
        }
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Best-effort temp cleanup; a stray .tmp file is harmless.
        }
    }
}
