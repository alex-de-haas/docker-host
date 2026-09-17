using System.Globalization;
using System.Text;

namespace Haas.Hosty.Core;

internal sealed partial class AppSourceService
{
    private const int MaxSourceImageBytes = 4 * 1024 * 1024;
    private const string ImageTooLarge = "Image exceeds the 4 MiB preview limit. Open it locally to view it.";

    private static bool IsSourceImagePath(string path)
        => Path.GetExtension(path).ToLowerInvariant() is ".png" or ".jpg" or ".jpeg" or ".gif" or ".webp";

    private static bool IsBinaryPatch(string patch)
        => patch.Split('\n').Any(line => line.StartsWith("Binary files ", StringComparison.Ordinal)
            || line == "GIT binary patch");

    private static async Task<AppSourceImagePreview> GetSourceImageAsync(AppSourceStatus status, AppSourceFile file,
        CancellationToken cancellationToken)
    {
        var scope = status.ScopePath!;
        AppSourceImageSide? before = null;
        if (status.Head is not null)
        {
            // Resolve only this literal path in the server-observed HEAD. Never accept a revision,
            // object ID or Git expression from the browser, and never follow Git symlink blobs.
            var tree = await WorktreeGitAsync(scope, ["ls-tree", "-z", status.Head, "--", file.Path], cancellationToken);
            var entries = tree.StandardOutput.Split('\0', StringSplitOptions.RemoveEmptyEntries);
            if (entries.Length > 1) throw SourceError("source_image_unsupported", "Only one regular image file can be previewed.");
            if (entries.Length == 1)
            {
                var metadata = entries[0].Split('\t', 2)[0].Split(' ');
                if (metadata.Length != 3 || metadata[0] is not ("100644" or "100755") || metadata[1] != "blob"
                    || !metadata[2].All(char.IsAsciiHexDigit))
                    throw SourceError("source_image_unsupported", "Symlinks and submodules cannot be previewed as images.");
                var oid = metadata[2];
                var sizeResult = await WorktreeGitAsync(scope, ["cat-file", "-s", oid], cancellationToken);
                if (!long.TryParse(sizeResult.StandardOutput.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var size))
                    throw SourceError("source_image_unsupported", "Image size could not be determined.");
                if (size > MaxSourceImageBytes) before = new(null, ImageTooLarge);
                else
                {
                    // Latin-1 maps every byte to exactly one character; never UTF-8-decode blobs.
                    // The same process runner retains a bounded output and enforces the Git deadline.
                    var blob = await WorktreeGitAsync(scope, ["cat-file", "blob", oid], cancellationToken,
                        limit: MaxSourceImageBytes, outputEncoding: Encoding.Latin1);
                    before = blob.StandardOutput.Length > MaxSourceImageBytes ? new(null, ImageTooLarge)
                        : DescribeSourceImage(Encoding.Latin1.GetBytes(blob.StandardOutput));
                }
            }
        }

        AppSourceImageSide? after = null;
        var fullPath = Path.Combine(scope, file.Path);
        if (File.Exists(fullPath))
        {
            // Recheck after Git work, then again before returning bytes. This follows the same
            // trusted-local-worktree boundary as text preview; it is not a sandbox for local writers.
            RequireSourceImagePath(scope, file.Path);
            await RequireRegularFileAsync(fullPath, cancellationToken);
            await using var stream = File.OpenRead(fullPath);
            if (stream.Length > MaxSourceImageBytes) after = new(null, ImageTooLarge);
            else
            {
                var bytes = new byte[MaxSourceImageBytes + 1];
                var count = await stream.ReadAtLeastAsync(bytes, bytes.Length, throwOnEndOfStream: false, cancellationToken);
                after = count > MaxSourceImageBytes ? new(null, ImageTooLarge) : DescribeSourceImage(bytes.AsSpan(0, count));
            }
        }
        RequireSourceImagePath(scope, file.Path);
        return new(before, after);
    }

    private static void RequireSourceImagePath(string scope, string path)
    {
        if (!IsRegularSourcePath(scope, path))
            throw SourceError("source_image_unsupported", "Only regular images inside the app source folder can be previewed.");
    }

    private static AppSourceImageSide DescribeSourceImage(ReadOnlySpan<byte> bytes)
    {
        // Restrict data URLs to browser raster formats. SVG/HTML and extension-only guesses
        // never become active content on the Core or Shell origin.
        string? mime = bytes.StartsWith(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }) ? "image/png"
            : bytes.StartsWith(new byte[] { 255, 216, 255 }) ? "image/jpeg"
            : bytes.StartsWith("GIF87a"u8) || bytes.StartsWith("GIF89a"u8) ? "image/gif"
            : bytes.Length >= 12 && bytes[..4].SequenceEqual("RIFF"u8) && bytes.Slice(8, 4).SequenceEqual("WEBP"u8) ? "image/webp"
            : null;
        return mime is null
            ? new(null, "This file is not a supported PNG, JPEG, GIF or WebP image. Open it locally to view it.")
            : new($"data:{mime};base64,{Convert.ToBase64String(bytes)}", null);
    }
}

internal sealed record AppSourceImageSide(string? DataUrl, string? Message);
internal sealed record AppSourceImagePreview(AppSourceImageSide? Before, AppSourceImageSide? After);
