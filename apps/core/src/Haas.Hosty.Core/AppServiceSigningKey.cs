using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

// The durable HMAC key behind HOSTY_APP_SERVICE_TOKEN. Unlike ControlSecret — deliberately
// per-process, because the control discovery file that carries it is rewritten every boot — this
// key must survive Core restarts: a keep-apps light restart leaves app containers running with
// their token baked into the container environment, and the next Core adopts them instead of
// recreating, so a per-process key would 401 every app→Core callback (directory roster,
// notifications, backups, session revalidation) until something else recreated the container.
internal sealed class AppServiceSigningKey(byte[] value)
{
    public byte[] Value { get; } = value;

    public static AppServiceSigningKey LoadOrCreate(CoreDataPaths paths)
    {
        var path = Path.Combine(paths.AuthRoot, "app-service-signing.key");

        var existing = TryReadKey(path);
        if (existing is not null)
        {
            SecureFileSystem.TryRestrictFile(path);
            return new AppServiceSigningKey(existing);
        }

        SecureFileSystem.EnsurePrivateDirectory(paths.AuthRoot);
        var key = RandomNumberGenerator.GetBytes(32);

        // First use: publish the key via a unique temp file + atomic rename so the real path is
        // never observed empty or partially written. overwrite:false means we lose cleanly if
        // another writer wins the rename.
        if (TryWriteKey(path, key, overwrite: false))
        {
            return new AppServiceSigningKey(key);
        }

        // Another writer created the file first; adopt its key.
        var winner = TryReadKey(path);
        if (winner is not null)
        {
            SecureFileSystem.TryRestrictFile(path);
            return new AppServiceSigningKey(winner);
        }

        // The file exists but holds no valid key (e.g. an empty file left behind by an older
        // crash). Replace it atomically with a fresh key.
        if (TryWriteKey(path, key, overwrite: true))
        {
            return new AppServiceSigningKey(key);
        }

        throw new IOException($"App service signing key could not be initialized at '{path}'.");
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
            return key.Length == 0 ? null : key;
        }
        catch (Exception ex) when (ex is IOException or FormatException or UnauthorizedAccessException)
        {
            // Missing, mid-rename, or poisoned content all read as absent — never as a valid
            // empty key, which would silently break signature validation forever.
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
        catch (IOException)
        {
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
