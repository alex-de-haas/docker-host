using System.Text.Json;

namespace Haas.Hosty.Core;

internal static class JsonStorage
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
    };

    public static async Task<T?> ReadAsync<T>(string path, CancellationToken cancellationToken = default)
    {
        try
        {
            await using var stream = File.OpenRead(path);
            return await JsonSerializer.DeserializeAsync<T>(stream, Options, cancellationToken);
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

    public static Task WriteAsync<T>(string path, T value, CancellationToken cancellationToken = default)
        => WriteAsync(path, value, restrictToOwner: false, cancellationToken);

    public static async Task WriteAsync<T>(string path, T value, bool restrictToOwner, CancellationToken cancellationToken = default)
    {
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            if (restrictToOwner)
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
            await using (var stream = restrictToOwner
                ? SecureFileSystem.CreatePrivateFile(tempPath, FileMode.CreateNew)
                : File.Create(tempPath))
            {
                await JsonSerializer.SerializeAsync(stream, value, Options, cancellationToken);
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
