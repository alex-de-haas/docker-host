using System.Buffers;
using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

// Content-addressed store for `prebuilt` artifacts. A prebuilt localCommand service delivers an
// already-compiled build (v1: a folder); Core hashes it, materializes an immutable copy under
// apps/<id>/runtimes/<key>/artifact/<hash>/, and runs the service `command` from there. The hash is
// the run-lock (ArtifactLock.BundleHash), mirroring the docker image digest lock: `pinned` re-runs the
// locked copy, `rolling` adopts the current delivery each start. Greenfield storage — no migration.
// See docs/features/runtime-artifact-model.md.
internal static class PrebuiltArtifactStore
{
    // Resolves the run directory and lock for a prebuilt service. Under `pinned` with a recorded hash
    // whose materialized copy still exists, the locked copy is re-run untouched; otherwise (rolling,
    // first start, backfill, or a missing copy) the current delivery is hashed and materialized.
    public static (string ArtifactRoot, ArtifactLock Lock) Resolve(
        string appRoot,
        string runtimeKey,
        string sourceRoot,
        RuntimePrebuiltDeliveryManifest delivery,
        ArtifactLock? existingLock,
        string policy)
    {
        var storeRoot = Path.Combine(appRoot, "runtimes", SanitizeSegment(runtimeKey), "artifact");

        if (string.Equals(policy, "pinned", StringComparison.Ordinal) &&
            !string.IsNullOrWhiteSpace(existingLock?.BundleHash))
        {
            var pinnedPath = Path.Combine(storeRoot, existingLock!.BundleHash!);
            if (Directory.Exists(pinnedPath))
            {
                return (pinnedPath, existingLock);
            }
        }

        var deliveryPath = ResolveDeliveryPath(sourceRoot, delivery);
        if (!Directory.Exists(deliveryPath))
        {
            throw new AppLifecycleException(
                "prebuilt_delivery_not_found",
                $"Prebuilt delivery folder was not found: {deliveryPath}");
        }

        var hash = HashDirectory(deliveryPath);
        var materializedPath = Path.Combine(storeRoot, hash);
        if (!Directory.Exists(materializedPath))
        {
            Directory.CreateDirectory(storeRoot);
            MaterializeCopy(deliveryPath, materializedPath);
        }

        var lockRecord = new ArtifactLock("prebuilt", null, deliveryPath, hash, null, DateTimeOffset.UtcNow);
        return (materializedPath, lockRecord);
    }

    // v1 delivery: a folder. A relative path resolves against the app's source root (the operator's
    // checkout/override), so a build sitting next to the source is addressable; an absolute path is
    // used as-is.
    internal static string ResolveDeliveryPath(string sourceRoot, RuntimePrebuiltDeliveryManifest delivery)
    {
        var path = delivery.Path ?? string.Empty;
        return Path.IsPathRooted(path)
            ? Path.GetFullPath(path)
            : Path.GetFullPath(Path.Combine(sourceRoot, path));
    }

    // A stable SHA-256 over the tree: for every file (ordinal-sorted by forward-slashed relative path)
    // the relative path and its streamed bytes are folded in, so the same build always yields the same
    // hash regardless of enumeration order and independent of host clocks/inode metadata.
    internal static string HashDirectory(string root)
    {
        var files = Directory
            .EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .Select(full => (Relative: Path.GetRelativePath(root, full).Replace('\\', '/'), Full: full))
            .OrderBy(entry => entry.Relative, StringComparer.Ordinal)
            .ToList();

        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = ArrayPool<byte>.Shared.Rent(81920);
        try
        {
            foreach (var (relative, full) in files)
            {
                hash.AppendData(Encoding.UTF8.GetBytes(relative));
                hash.AppendData([0]);
                using var stream = File.OpenRead(full);
                int read;
                while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
                {
                    hash.AppendData(buffer.AsSpan(0, read));
                }

                hash.AppendData([0]);
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }

        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    // Copies the delivery into a temp sibling then atomically renames it in, so a crash mid-copy never
    // leaves a partial artifact/<hash> dir that a later start would mistake for a complete one.
    private static void MaterializeCopy(string source, string destination)
    {
        var staging = destination + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            CopyDirectory(source, staging);
            Directory.Move(staging, destination);
        }
        catch (IOException) when (Directory.Exists(destination))
        {
            // A concurrent start already materialized this hash — discard our staging copy.
            TryDeleteDirectory(staging);
        }
        catch
        {
            TryDeleteDirectory(staging);
            throw;
        }
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var directory in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(Path.Combine(destination, Path.GetRelativePath(source, directory)));
        }

        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(destination, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, overwrite: true);
        }
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    private static string SanitizeSegment(string value)
        => CoreDataPaths.IsSafePathSegment(value) ? value : "runtime";
}
