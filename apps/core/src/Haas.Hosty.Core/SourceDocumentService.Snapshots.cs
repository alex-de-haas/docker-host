using System.Diagnostics;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text;

namespace Haas.Hosty.Core;

internal sealed partial class SourceDocumentService
{
    private sealed class SnapshotMetadataBudget
    {
        internal long Bytes { get; private set; }
        internal void AddDocument(string path, int shaLength) => Add(128L + (path.Length + shaLength) * 2L);
        internal void AddReference(string path) => Add(64L + path.Length * 2L);
        private void Add(long bytes)
        {
            if (bytes > MetadataLimit - Bytes)
                throw Error("size_limit", "Document listing exceeds its 64 MiB metadata limit. Request a focused document listing.");
            Bytes += bytes;
        }
    }
    private sealed record TreeSnapshot(TreeFile[] Files, IReadOnlyDictionary<string, TreeFile> Metadata);
    private readonly SourceDocumentSnapshotCache snapshots = new();
    private int treeLoads, blobProcesses;
    internal (int Entries, long Bytes, int TreeLoads, int BlobProcesses) SnapshotStatistics
    {
        get { var cache = snapshots.Statistics; return (cache.Count, cache.Bytes, treeLoads, blobProcesses); }
    }
    private static string TreeKey(string root, string commit) => "tree\n" + root + "\n" + commit;
    private static string DocumentsKey(string root, string commit) => "documents\n" + root + "\n" + commit;
    private static string BlobKey(string root, string sha) => "blob\n" + root + "\n" + sha;
    private static SourceDocument[] CopyDocuments(SourceDocument[] documents)
        => documents.Select(document => document with { ReferencePaths = document.ReferencePaths?.ToArray() }).ToArray();

    private Task<TreeSnapshot> TreeSnapshotAsync(string root, string commit, CancellationToken ct)
        => snapshots.GetAsync(TreeKey(root, commit), async token =>
        {
            Interlocked.Increment(ref treeLoads);
            var files = ParseTree((await DevelopmentWorkspaceService.Git(root, ["ls-tree", "-r", "-t", "-l", "-z", commit], token)).StandardOutput);
            return (new TreeSnapshot(files, files.ToDictionary(file => file.Path, StringComparer.Ordinal)),
                files.Sum(file => 192L + (file.Path.Length + file.Sha.Length + file.Mode.Length) * 2L));
        }, ct);

    private Task<SourceDocument[]> ImmutableDocumentsAsync(string root, string commit, CancellationToken ct, string? documentPath = null)
    {
        if (documentPath is not null) return FocusedImmutableDocumentAsync(root, commit, documentPath, ct);
        return snapshots.GetAsync(DocumentsKey(root, commit), async token =>
        {
            var tree = await TreeSnapshotAsync(root, commit, token);
            var files = tree.Files.Where(file => IsDocumentPath(file.Path) && file.Mode is "100644" or "100755").ToArray();
            if (files.Length > DocumentLimit) throw Error("size_limit", "Repository contains too many documents.");
            foreach (var file in files) RequireTreeFile(file);
            var bySha = files.ToLookup(file => file.Sha, StringComparer.Ordinal);
            var documents = new Dictionary<string, SourceDocument>(StringComparer.Ordinal);
            var budget = new SnapshotMetadataBudget();
            await foreach (var (sha, bytes) in ReadSnapshotBlobsAsync(root, files, token))
            {
                var content = Text(bytes);
                foreach (var file in bySha[sha])
                {
                    token.ThrowIfCancellationRequested();
                    budget.AddDocument(file.Path, file.Sha.Length);
                    documents[file.Path] = new(file.Path, file.Sha, file.Size,
                        ReferencePaths: await ReferencesAsync(content, file.Path, (root, commit), null, token, tree.Metadata, budget));
                }
            }
            var result = files.Select(file => documents[file.Path]).ToArray();
            return (result, budget.Bytes);
        }, ct);
    }

    private async Task<SourceDocument[]> FocusedImmutableDocumentAsync(string root, string commit, string path, CancellationToken ct)
    {
        if (snapshots.TryGet<SourceDocument[]>(DocumentsKey(root, commit), out var listing))
            return listing.Where(document => document.Path == path).ToArray();
        var tree = await TreeSnapshotAsync(root, commit, ct);
        if (!tree.Metadata.TryGetValue(path, out var file)) return [];
        RequireTreeFile(file);
        var bytes = await SnapshotBlobAsync(root, file, ct);
        return [new(file.Path, file.Sha, file.Size,
            ReferencePaths: await ReferencesAsync(Text(bytes), file.Path, (root, commit), null, ct, tree.Metadata))];
    }

    private Task<byte[]> SnapshotBlobAsync(string root, TreeFile file, CancellationToken ct)
        => snapshots.GetAsync(BlobKey(root, file.Sha), async token =>
        {
            byte[]? content = null;
            await foreach (var (_, bytes) in ReadBlobBatchAsync(root, [file], token)) content = bytes;
            return content is null ? throw Error("unavailable", "Document blob could not be read.") : (content, content.LongLength);
        }, ct);

    private async IAsyncEnumerable<(string Sha, byte[] Bytes)> ReadSnapshotBlobsAsync(string root, TreeFile[] files,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var missing = new List<TreeFile>();
        foreach (var file in files.DistinctBy(file => file.Sha))
        {
            ct.ThrowIfCancellationRequested();
            if (snapshots.TryGet<byte[]>(BlobKey(root, file.Sha), out var bytes)) yield return (file.Sha, bytes);
            else missing.Add(file);
        }
        if (missing.Count == 0) yield break;
        await foreach (var (sha, bytes) in ReadBlobBatchAsync(root, missing, ct))
        {
            snapshots.Set(BlobKey(root, sha), bytes, bytes.LongLength);
            yield return (sha, bytes);
        }
    }

    private async IAsyncEnumerable<(string Sha, byte[] Bytes)> ReadBlobBatchAsync(string root, IReadOnlyList<TreeFile> files,
        [EnumeratorCancellation] CancellationToken ct)
    {
        foreach (var file in files)
        {
            ct.ThrowIfCancellationRequested();
            RequireTreeFile(file);
            if (file.Sha.Length is not (40 or 64) || !file.Sha.All(char.IsAsciiHexDigit)) throw Error("invalid", "Invalid document blob.");
        }
        var start = DevelopmentWorkspaceService.GitStartInfo(root, ["cat-file", "--batch"]);
        start.RedirectStandardInput = start.RedirectStandardOutput = start.RedirectStandardError = true;
        start.UseShellExecute = false;
        using var process = new Process { StartInfo = start };
        process.Start(); Interlocked.Increment(ref blobProcesses);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct); deadline.CancelAfter(TimeSpan.FromSeconds(10));
        var errors = process.StandardError.ReadToEndAsync(CancellationToken.None);
        var input = WriteBlobRequestsAsync(process, files, deadline.Token);
        await using var output = new BufferedStream(process.StandardOutput.BaseStream, 16384);
        try
        {
            foreach (var file in files)
            {
                var header = (await BatchHeaderAsync(output, deadline.Token)).Split(' ');
                if (header.Length != 3 || header[0] != file.Sha || header[1] != "blob"
                    || !int.TryParse(header[2], NumberStyles.None, CultureInfo.InvariantCulture, out var length) || length != file.Size)
                    throw Error("unavailable", "Document blob response does not match its immutable tree.");
                if (length > FileLimit) throw Error("size_limit", "Document exceeds the one MiB size limit.");
                var bytes = new byte[length];
                await BatchBytesAsync(output, bytes, deadline.Token);
                if (await BatchHeaderAsync(output, deadline.Token) != "") throw Error("unavailable", "Invalid document blob framing.");
                if (BlobSha(bytes, file.Sha.Length == 64 ? "sha256" : "sha1") != file.Sha)
                    throw Error("conflict", "Document bytes no longer match the listed version.");
                yield return (file.Sha, bytes);
            }
            await input;
            await process.WaitForExitAsync(deadline.Token);
            await errors;
            if (process.ExitCode != 0) throw Error("unavailable", "Document blobs could not be read.");
        }
        finally
        {
            if (!process.HasExited) { try { process.Kill(true); } catch (InvalidOperationException) { } }
            try { await input; } catch (Exception ex) when (ex is IOException or OperationCanceledException) { }
            await errors;
            process.StandardInput.Dispose(); process.StandardError.Dispose();
        }
    }

    private static async Task WriteBlobRequestsAsync(Process process, IReadOnlyList<TreeFile> files, CancellationToken ct)
    {
        foreach (var file in files) await process.StandardInput.WriteLineAsync(file.Sha.AsMemory(), ct);
        process.StandardInput.Close();
    }

    private static async Task<string> BatchHeaderAsync(Stream output, CancellationToken ct)
    {
        var bytes = new byte[256];
        for (var count = 0; count < bytes.Length; count++)
        {
            await BatchBytesAsync(output, bytes.AsMemory(count, 1), ct);
            if (bytes[count] == '\n') return Encoding.ASCII.GetString(bytes, 0, count);
        }
        throw Error("unavailable", "Invalid document blob response header.");
    }

    private static async Task BatchBytesAsync(Stream output, Memory<byte> bytes, CancellationToken ct)
    {
        try { await output.ReadExactlyAsync(bytes, ct); }
        catch (EndOfStreamException) { throw Error("unavailable", "Incomplete document blob response."); }
    }
}
