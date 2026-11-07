using System.Runtime.InteropServices;
using System.Buffers.Binary;
using System.Text;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class StorageUsageTests
{
    [Fact]
    public async Task TotalsAreAdditiveAcrossEveryCategoryAndGlobalHardlinks()
    {
        using var root = new StorageTestRoot();
        var fs = new EntriesFileSystem([
            Entry("apps/org.independent.notes/data/a", 1, 4096, 10),
            Entry("apps/org.independent.notes/logs/b", 2, 8192, 20),
            Entry("apps/org.independent.notes/source/code", 3, 4096, 30),
            Entry("sources/shared.git/object", 4, 512, 40),
            Entry("core/development/trees/tree/src", 5, 1024, 50),
            Entry("environments/preview/data", 6, 4096, 60),
            Entry("backups/org.independent.notes/2026/archive", 7, 1024, 70),
            Entry("core/audit/log", 8, 512, 80),
            Entry("unknown/place/file", 9, 4096, 90),
            Entry("unknown/hardlink", 1, 4096, 10),
            Entry("unknown/directory", 10, 4096, 0) with { Directory = true }
        ]);
        var snapshot = await Scan(root.Path, fs);
        Assert.False(snapshot.Partial);
        Assert.Equal(450, snapshot.LogicalBytes);
        Assert.Equal(31744, snapshot.AllocatedBytes);
        Assert.Equal(snapshot.AllocatedBytes, snapshot.Categories.Sum(c => c.AllocatedBytes));
        Assert.Equal(snapshot.LogicalBytes, snapshot.Resources.Sum(r => r.LogicalBytes));
        Assert.All(snapshot.Resources, r =>
        {
            Assert.Equal(r.AllocatedBytes, r.Parts.Sum(p => p.AllocatedBytes));
            Assert.Equal(r.LogicalBytes, r.Parts.Sum(p => p.LogicalBytes));
        });
        var app = Assert.Single(snapshot.Resources, r => r.Kind == "app");
        Assert.Equal("org.independent.notes", app.AppId);
        Assert.Equal(30, app.LogicalBytes);
        Assert.Equal(["org.independent.notes"], Assert.Single(snapshot.Resources, r => r.Kind == "backup").RelatedAppIds);
    }

    [Fact]
    public async Task SharedRepositoriesWorkspacesAndEnvironmentsHaveRelationsWithoutDuplicatingOwnership()
    {
        using var root = new StorageTestRoot();
        var fs = new EntriesFileSystem([
            Document("apps/vendor.a/state.json", 1, """{"app":{"id":"vendor.a","displayName":"Notes","sourceState":{"managedCheckoutPath":"/outside/source"},"settings":{"secret":"never-export"}}}"""),
            Document("core/development/workspaces/tree.json", 2, """{"id":"tree","workspaceId":"workspace","repositoryId":"repo","apps":[{"appId":"vendor.a"},{"appId":"unrelated.vendor.b"}],"owner":{"sessionId":"never-export"}}"""),
            Document("core/development/metadata/workspace.json", 3, """{"name":"Storage feature"}"""),
            Document("core/environments/preview.json", 4, """{"id":"preview","request":{"label":"Preview","worktreeIds":["tree"]}}"""),
            Entry("core/development/trees/tree/file", 5, 100, 10),
            Entry("core/development/repositories/repo.git/objects/x", 6, 200, 20),
            Entry("apps/vendor.a/source/code", 7, 300, 30),
            Entry("environments/preview/apps/vendor.a/data/x", 8, 400, 40)
        ]);
        var snapshot = await Scan(root.Path, fs);
        var tree = Assert.Single(snapshot.Resources, r => r.Kind == "worktree");
        Assert.Equal("Storage feature", tree.Label);
        Assert.Equal("workspace", tree.WorkspaceId);
        Assert.Equal("tree", tree.WorktreeId);
        Assert.Equal(["unrelated.vendor.b", "vendor.a"], tree.RelatedAppIds);
        Assert.Equal(tree.RelatedAppIds, Assert.Single(snapshot.Resources, r => r.RelativePath.EndsWith("repo.git")).RelatedAppIds);
        var environment = Assert.Single(snapshot.Resources, r => r.Kind == "environment");
        Assert.Equal("Preview", environment.Label);
        Assert.Equal(tree.RelatedAppIds, environment.RelatedAppIds);
        Assert.Null(tree.AppId);
        Assert.Equal("Notes", Assert.Single(snapshot.Resources, r => r.Kind == "app").Label);
        Assert.Equal(["vendor.a"], Assert.Single(snapshot.Resources, r => r.Kind == "managed-source").RelatedAppIds);
        var json = CoreJson.Text(new StorageUsageState(snapshot, false, null));
        Assert.DoesNotContain("never-export", json);
        Assert.DoesNotContain("/outside/source", json);
        Assert.DoesNotContain("settings", json);
    }

    [Fact]
    public async Task ExcludedLinksAndMountsAreNotZeroByteResourcesAndErrorsStayExplicitAndBounded()
    {
        using var root = new StorageTestRoot();
        var entries = new List<StorageFileEntry>
        {
            Entry("linked-outside", 1, 8192, 8192) with { SymbolicLink = true },
            Entry("bind-mount", 2, 8192, 8192) with { Mount = true },
            Entry("apps/removed.app/data/local", 3, 1024, 50)
        };
        entries.AddRange(Enumerable.Range(1, 150).Select(i => new StorageFileEntry($"unknown/unreadable-{i}", 0, 0, 0, 0, false, false, false, Error: "entry_unreadable")));
        var snapshot = await Scan(root.Path, new EntriesFileSystem(entries));
        Assert.True(snapshot.Partial);
        Assert.Equal(1, snapshot.ExcludedSymlinkCount);
        Assert.Equal(1, snapshot.ExcludedMountCount);
        Assert.Equal(150, snapshot.IssueCount);
        Assert.Equal(StorageUsageScanner.MaximumIssues, snapshot.Issues.Length);
        Assert.DoesNotContain(snapshot.Resources, r => r.Id is "linked-outside" or "bind-mount");
        Assert.Equal(50, snapshot.LogicalBytes);
        Assert.Contains(snapshot.Resources, r => r.AppId == "removed.app");
    }

    [Fact]
    public async Task UnavailableAllocationIsNullAndNotLogicalBytesOrCompleteZero()
    {
        using var root = new StorageTestRoot();
        var snapshot = await Scan(root.Path, new EntriesFileSystem([
            new("", 0, 0, 0, 0, false, false, false, Error: "filesystem_metadata_unavailable"),
            Entry("unknown/file", 1, 0, 123)
        ]));
        Assert.True(snapshot.Partial);
        Assert.Null(snapshot.AllocatedBytes);
        Assert.Equal(123, snapshot.LogicalBytes);
        Assert.All(snapshot.Categories, c => Assert.Null(c.AllocatedBytes));
    }

    [Fact]
    public async Task ResourceOutputLimitStopsWithPartialSnapshot()
    {
        using var root = new StorageTestRoot();
        var fs = new EntriesFileSystem(Enumerable.Range(1, StorageUsageScanner.MaximumResources + 10)
            .Select(i => Entry($"unknown-{i}/file", (ulong)i, 512, 1)));
        var snapshot = await Scan(root.Path, fs);
        Assert.True(snapshot.Partial);
        Assert.Equal(StorageUsageScanner.MaximumResources, snapshot.Resources.Length);
        Assert.Contains(snapshot.Issues, i => i.Code == "resource_limit");
        Assert.All(snapshot.Resources, r => Assert.True(r.Partial));
    }

    [Fact]
    public async Task LegacyCoreSourceIsOneRepositoryAndNativeLimitMarksAllResultsPartial()
    {
        using var root = new StorageTestRoot();
        var snapshot = await Scan(root.Path, new EntriesFileSystem([
            Entry("core/source/.git/objects/x", 1, 512, 1),
            Entry("core/source/apps/third-party/file", 2, 1024, 2),
            Entry("core/source/README.md", 3, 512, 3),
            new("other", 0, 0, 0, 0, false, false, false, Error: "scan_limit"),
            Entry("not-measured", 4, 512, 4)
        ]));
        var source = Assert.Single(snapshot.Resources, r => r.Kind == "repository");
        Assert.Equal("core/source", source.RelativePath);
        Assert.Equal(6, source.LogicalBytes);
        Assert.True(snapshot.Partial);
        Assert.All(snapshot.Resources, r => Assert.True(r.Partial));
        Assert.DoesNotContain(snapshot.Resources, r => r.Id == "not-measured");
    }

    [Fact]
    public async Task NativeEmptyRegistryAndUnknownFoldersWorkWithoutAnyInstalledApps()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS() && !OperatingSystem.IsWindows()) return;
        using var root = new StorageTestRoot();
        Directory.CreateDirectory(System.IO.Path.Combine(root.Path, "unclassified", "nested"));
        await File.WriteAllTextAsync(System.IO.Path.Combine(root.Path, "unclassified", "nested", "file"), "hello");
        var snapshot = await Scan(root.Path, new StorageFileSystem());
        Assert.False(snapshot.Partial, string.Join(", ", snapshot.Issues));
        Assert.Equal(5, snapshot.LogicalBytes);
        Assert.Equal(6, snapshot.Categories.Length);
        Assert.Contains(snapshot.Resources, r => r.Category == "other" && r.RelativePath == "unclassified");
        Assert.DoesNotContain(snapshot.Resources, r => r.Kind == "app");
    }

    [Fact]
    public async Task NativeRegistryDocumentsProjectOnlyPublicLabelsAcrossSupportedPlatforms()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS() && !OperatingSystem.IsWindows()) return;
        using var root = new StorageTestRoot();
        var app = System.IO.Path.Combine(root.Path, "apps", "net.independent.app");
        Directory.CreateDirectory(System.IO.Path.Combine(app, "data"));
        await File.WriteAllTextAsync(System.IO.Path.Combine(app, "state.json"), """{"app":{"id":"net.independent.app","displayName":"Independent","settings":{"secret":"private-value"}}}""");
        await File.WriteAllTextAsync(System.IO.Path.Combine(app, "data", "example"), "data");
        var snapshot = await Scan(root.Path, new StorageFileSystem());
        Assert.False(snapshot.Partial, string.Join(", ", snapshot.Issues));
        var resource = Assert.Single(snapshot.Resources, r => r.AppId == "net.independent.app");
        Assert.Equal("Independent", resource.Label);
        Assert.Equal(4, Assert.Single(resource.Parts, p => p.Id == "data").LogicalBytes);
        Assert.DoesNotContain("private-value", CoreJson.Text(new StorageUsageState(snapshot, false, null)));
    }

    [Fact]
    public async Task NativeTraversalReadsActualRegistryPathsAndExcludesSymlinksAndGlobalHardlinks()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) return;
        using var root = new StorageTestRoot();
        using var outside = new StorageTestRoot();
        await File.WriteAllTextAsync(System.IO.Path.Combine(outside.Path, "secret"), new string('x', 10000));
        Directory.CreateSymbolicLink(System.IO.Path.Combine(root.Path, "external-mount-like-link"), outside.Path);
        File.CreateSymbolicLink(System.IO.Path.Combine(root.Path, "external-file"), System.IO.Path.Combine(outside.Path, "secret"));
        var appRoot = System.IO.Path.Combine(root.Path, "apps", "org.independent.app");
        Directory.CreateDirectory(System.IO.Path.Combine(appRoot, "data"));
        var data = System.IO.Path.Combine(appRoot, "data", "file");
        await File.WriteAllTextAsync(data, "payload");
        Assert.Equal(0, Link(data, System.IO.Path.Combine(root.Path, "hardlink")));
        await File.WriteAllTextAsync(System.IO.Path.Combine(appRoot, "state.json"), """{"app":{"id":"org.independent.app","displayName":"Independent app"}}""");
        var workspaces = System.IO.Path.Combine(root.Path, "core", "development", "workspaces");
        Directory.CreateDirectory(workspaces);
        await File.WriteAllTextAsync(System.IO.Path.Combine(workspaces, "tree.json"), """{"id":"tree","workspaceId":"workspace","repositoryId":"repo","apps":[{"appId":"org.independent.app"}]}""");
        Directory.CreateDirectory(System.IO.Path.Combine(root.Path, "core", "development", "trees", "tree"));
        var snapshot = await Scan(root.Path, new StorageFileSystem());
        Assert.False(snapshot.Partial, string.Join(", ", snapshot.Issues));
        Assert.Equal(2, snapshot.ExcludedSymlinkCount);
        Assert.Equal("Independent app", Assert.Single(snapshot.Resources, r => r.Kind == "app").Label);
        Assert.Equal(["org.independent.app"], Assert.Single(snapshot.Resources, r => r.Kind == "worktree").RelatedAppIds);
        var expected = Directory.EnumerateFiles(root.Path, "*.json", SearchOption.AllDirectories).Sum(p => new FileInfo(p).Length) + 7;
        Assert.Equal(expected, snapshot.LogicalBytes);
        Assert.DoesNotContain(snapshot.Resources, r => r.Id.StartsWith("external", StringComparison.Ordinal));
    }

    [Fact]
    public async Task NativeSparseFilesReportAllocatedBlocksSeparatelyFromLogicalLength()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) return;
        using var root = new StorageTestRoot();
        using (var stream = File.Create(System.IO.Path.Combine(root.Path, "sparse"))) stream.SetLength(16 * 1024 * 1024);
        var snapshot = await Scan(root.Path, new StorageFileSystem());
        Assert.False(snapshot.Partial, string.Join(", ", snapshot.Issues));
        Assert.Equal(16 * 1024 * 1024, snapshot.LogicalBytes);
        Assert.True(snapshot.AllocatedBytes < snapshot.LogicalBytes);
    }

    [Fact]
    public async Task NativeDirectoryReplacedWithSymlinkBetweenStatAndOpenIsNeverFollowed()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) return;
        using var root = new StorageTestRoot();
        using var outside = new StorageTestRoot();
        await File.WriteAllTextAsync(System.IO.Path.Combine(outside.Path, "private-target"), "private");
        var original = System.IO.Path.Combine(root.Path, "replace-me");
        Directory.CreateDirectory(original);
        using var entries = new StorageFileSystem().Walk(root.Path, default).GetEnumerator();
        while (entries.MoveNext() && entries.Current.RelativePath != "replace-me") { }
        Assert.Equal("replace-me", entries.Current.RelativePath);
        Directory.Move(original, System.IO.Path.Combine(root.Path, "retained"));
        Directory.CreateSymbolicLink(original, outside.Path);
        var remaining = new List<StorageFileEntry>();
        while (entries.MoveNext()) remaining.Add(entries.Current);
        Assert.DoesNotContain(remaining, e => e.RelativePath.Contains("private-target", StringComparison.Ordinal));
        Assert.Contains(remaining, e => e.Error == "directory_changed_or_unreadable");
    }

    [Fact]
    public async Task NativeDisappearingEntryProducesPartialIssueWithoutDroppingOtherFiles()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) return;
        using var root = new StorageTestRoot();
        await File.WriteAllTextAsync(System.IO.Path.Combine(root.Path, "a"), "a");
        await File.WriteAllTextAsync(System.IO.Path.Combine(root.Path, "b"), "b");
        using var entries = new StorageFileSystem().Walk(root.Path, default).GetEnumerator();
        Assert.True(entries.MoveNext()); // root allocation
        Assert.True(entries.MoveNext()); // sorted a; sibling names are already anchored/enumerated
        Assert.Equal("a", entries.Current.RelativePath);
        File.Delete(System.IO.Path.Combine(root.Path, "b"));
        Assert.True(entries.MoveNext());
        Assert.Equal("b", entries.Current.RelativePath);
        Assert.Equal("entry_unreadable", entries.Current.Error);
    }

    [Fact]
    public void WindowsDirectoryBufferParsesAlignedUnicodeNamesAndSkipsDotEntries()
    {
        static byte[] Record(string name, bool next)
        {
            var bytes = Encoding.Unicode.GetBytes(name);
            var record = new byte[(104 + bytes.Length + 7) & ~7];
            BinaryPrimitives.WriteUInt32LittleEndian(record, next ? (uint)record.Length : 0);
            BinaryPrimitives.WriteUInt32LittleEndian(record.AsSpan(60), (uint)bytes.Length);
            bytes.CopyTo(record, 104); return record;
        }
        var buffer = Record(".", true).Concat(Record("папка", true)).Concat(Record("other.txt", false)).ToArray();
        Assert.Equal(["папка", "other.txt"], StorageWindowsFileSystem.ParseDirectoryBuffer(buffer));
        BinaryPrimitives.WriteUInt32LittleEndian(buffer, 7); // invalid alignment/offset
        Assert.Throws<InvalidDataException>(() => StorageWindowsFileSystem.ParseDirectoryBuffer(buffer));
    }

    [Theory]
    [InlineData("../outside")]
    [InlineData("folder\\outside")]
    [InlineData("file:alternate-stream")]
    public void WindowsDirectoryBufferRejectsTraversalAndAlternateStreams(string name)
    {
        var bytes = Encoding.Unicode.GetBytes(name);
        var buffer = new byte[104 + bytes.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(buffer.AsSpan(60), (uint)bytes.Length);
        bytes.CopyTo(buffer, 104);
        Assert.Throws<InvalidDataException>(() => StorageWindowsFileSystem.ParseDirectoryBuffer(buffer));
    }

    [Fact]
    public async Task Full128BitFileIdentityDistinguishesWindowsIdsWithSameLowHalf()
    {
        using var root = new StorageTestRoot();
        var snapshot = await Scan(root.Path, new EntriesFileSystem([
            Entry("a", 1, 512, 1) with { InodeHigh = 100 },
            Entry("b", 1, 1024, 2) with { InodeHigh = 200 },
            Entry("c-hardlink", 1, 512, 1) with { InodeHigh = 100 }
        ]));
        Assert.Equal(3, snapshot.LogicalBytes);
        Assert.Equal(1536, snapshot.AllocatedBytes);
    }

    private static Task<StorageUsageSnapshot> Scan(string root, IStorageFileSystem fs)
        => new StorageUsageScanner(CoreOriginTestFactory.PathsFor(root), fs, new SystemClock()).ScanAsync();
    internal static StorageFileEntry Entry(string path, ulong inode, long allocated = 512, long logical = 1)
        => new(path, 1, inode, allocated, logical, false, false, false);
    private static StorageFileEntry Document(string path, ulong inode, string json)
        => Entry(path, inode, 0, 0) with { Metadata = Encoding.UTF8.GetBytes(json) };
    [DllImport("libc", EntryPoint = "link", SetLastError = true)] private static extern int Link(string original, string link);

    internal sealed class EntriesFileSystem(IEnumerable<StorageFileEntry> entries) : IStorageFileSystem
    {
        public IEnumerable<StorageFileEntry> Walk(string root, CancellationToken ct) => entries;
    }
    private sealed class StorageTestRoot : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"hosty-storage-tests-{Guid.NewGuid():N}");
        public StorageTestRoot() => Directory.CreateDirectory(Path);
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
