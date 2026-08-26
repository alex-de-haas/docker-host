using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

namespace Haas.Hosty.Core;

// Identity of one on-disk document version, used by stores that cache their parsed state: a stamp
// mismatch means the file changed behind the cache (an out-of-band edit, another store instance) and
// the cached copy must be re-read. Writes inside the process refresh caches directly; the stamp is
// the guard for the writers the process cannot see.
internal readonly record struct FileStamp(bool Exists, DateTime LastWriteTimeUtc, long Length)
{
    public static FileStamp Read(string path)
    {
        var info = new FileInfo(path);
        return info.Exists ? new FileStamp(true, info.LastWriteTimeUtc, info.Length) : default;
    }
}

internal static class JsonStorage
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        TypeInfoResolver = CoreJsonSerializerContext.Default,
    };

    // AOT-safe JsonTypeInfo lookup: resolves through the source-generated context configured on
    // Options. Throws NotSupportedException at runtime for a type missing from the context, which
    // is the same fail-fast behavior Native AOT enforces.
    private static JsonTypeInfo<T> TypeInfo<T>()
        => Options.GetTypeInfo(typeof(T)) as JsonTypeInfo<T>
            ?? throw new NotSupportedException(
                $"Type '{typeof(T).FullName}' is not registered in {nameof(CoreJsonSerializerContext)}.");

    public static async Task<T?> ReadAsync<T>(string path, CancellationToken cancellationToken = default)
    {
        try
        {
            await using var stream = File.OpenRead(path);
            return await JsonSerializer.DeserializeAsync(stream, TypeInfo<T>(), cancellationToken);
        }
        catch (FileNotFoundException)
        {
            return default;
        }
        catch (DirectoryNotFoundException)
        {
            return default;
        }
    }

    // Atomically writes already-serialized text (JSON, YAML, …) via temp+rename, so a crash mid-write
    // can never leave a half-written file that bricks a later read. Same durability contract as
    // WriteAsync<T> but for content the caller has already rendered to a string.
    public static async Task WriteTextAsync(string path, string content, CancellationToken cancellationToken = default)
    {
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var tempPath = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            await File.WriteAllTextAsync(tempPath, content, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false), cancellationToken);
            File.Move(tempPath, path, overwrite: true);
        }
        catch
        {
            try
            {
                File.Delete(tempPath);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Best-effort cleanup of the abandoned temp file.
            }

            throw;
        }
    }

    public static Task WriteAsync<T>(string path, T value, CancellationToken cancellationToken = default)
        => WriteAsync(path, value, restrictToOwner: false, cancellationToken);

    // Owner-only file inside an ordinary directory. Distinct from restrictToOwner, which also locks
    // the containing directory: app state lives at apps/<id>/state.json, next to the bind-mounted
    // data/ that a container running as another uid must still traverse. The secret is in the file,
    // not the directory listing, so restricting the file is the part that matters.
    public static Task WriteOwnerFileAsync<T>(string path, T value, CancellationToken cancellationToken = default)
        => WriteCoreAsync(path, value, restrictFile: true, restrictDirectory: false, cancellationToken);

    public static Task WriteAsync<T>(string path, T value, bool restrictToOwner, CancellationToken cancellationToken = default)
        => WriteCoreAsync(path, value, restrictFile: restrictToOwner, restrictDirectory: restrictToOwner, cancellationToken);

    private static async Task WriteCoreAsync<T>(string path, T value, bool restrictFile, bool restrictDirectory, CancellationToken cancellationToken)
    {
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            if (restrictDirectory)
            {
                SecureFileSystem.EnsurePrivateDirectory(directory);
            }
            else
            {
                Directory.CreateDirectory(directory);
            }
        }

        var tempPath = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            await using (var stream = restrictFile
                ? SecureFileSystem.CreatePrivateFile(tempPath, FileMode.CreateNew)
                : File.Create(tempPath))
            {
                await JsonSerializer.SerializeAsync(stream, value, TypeInfo<T>(), cancellationToken);
                await stream.FlushAsync(cancellationToken);
            }

            File.Move(tempPath, path, overwrite: true);
        }
        catch
        {
            try
            {
                File.Delete(tempPath);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Best-effort cleanup of the abandoned temp file.
            }

            throw;
        }
    }
}
