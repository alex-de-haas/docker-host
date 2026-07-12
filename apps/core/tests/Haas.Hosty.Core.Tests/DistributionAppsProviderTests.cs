using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class DistributionAppsProviderTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-distribution-tests-{Guid.NewGuid():N}");

    [Fact]
    public async Task LoadAsync_ExplicitFile_ResolvesRelativeRefsAgainstFileDirectory()
    {
        var path = WriteList("""
            {
              "schemaVersion": "distribution-apps.0.1",
              "apps": [
                { "id": "hosty.shell", "title": "Hosty Shell", "manifestRef": "apps/shell/manifest.json", "defaultEnabled": true },
                { "id": "hosty.marketplace", "manifestRef": "https://example.test/marketplace/manifest.json", "feedsUrl": "https://example.test/marketplace/feeds.json", "defaultEnabled": false }
              ]
            }
            """);

        var result = await CreateProvider(path).LoadAsync();

        Assert.Empty(result.Problems);
        Assert.Equal(2, result.Apps.Count);
        var shell = result.Apps[0];
        Assert.Equal(Path.GetFullPath(Path.Combine(root, "apps", "shell", "manifest.json")), shell.ManifestRef);
        Assert.True(shell.DefaultEnabled);
        var marketplace = result.Apps[1];
        // Title falls back to the id; absolute URLs pass through untouched.
        Assert.Equal("hosty.marketplace", marketplace.Title);
        Assert.Equal("https://example.test/marketplace/manifest.json", marketplace.ManifestRef);
        Assert.Equal("https://example.test/marketplace/feeds.json", marketplace.FeedsUrl);
        Assert.False(marketplace.DefaultEnabled);
    }

    [Fact]
    public async Task LoadAsync_MissingOverridePath_ReportsProblemAndFallsBackToEmbedded()
    {
        var provider = CreateProvider(Path.Combine(root, "does-not-exist.json"));

        var result = await provider.LoadAsync();

        Assert.Equal("embedded default", result.Source);
        Assert.Contains(result.Problems, problem => problem.Contains("could not be read", StringComparison.Ordinal));
        Assert.Contains(result.Apps, entry => entry.Id == "hosty.shell");
        Assert.Contains(result.Apps, entry => entry.Id == "hosty.telemetry");
        Assert.Contains(result.Apps, entry => entry.Id == "hosty.marketplace");
    }

    [Fact]
    public async Task LoadAsync_MalformedFile_ReportsProblemAndFallsBackToEmbedded()
    {
        var path = WriteList("{ not json");

        var result = await CreateProvider(path).LoadAsync();

        Assert.Equal("embedded default", result.Source);
        Assert.Contains(result.Problems, problem => problem.Contains("not valid JSON", StringComparison.Ordinal));
        Assert.NotEmpty(result.Apps);
    }

    [Fact]
    public async Task LoadAsync_WrongSchemaVersion_ReportsProblemAndFallsBackToEmbedded()
    {
        var path = WriteList("""
            { "schemaVersion": "system-apps.0.1", "apps": [ { "id": "hosty.shell", "manifestRef": "x" } ] }
            """);

        var result = await CreateProvider(path).LoadAsync();

        Assert.Equal("embedded default", result.Source);
        Assert.Contains(result.Problems, problem => problem.Contains("schemaVersion", StringComparison.Ordinal));
    }

    [Fact]
    public async Task LoadAsync_InvalidEntriesAreSkippedWithProblems()
    {
        var path = WriteList("""
            {
              "schemaVersion": "distribution-apps.0.1",
              "apps": [
                { "id": "hosty.shell", "manifestRef": "apps/shell/manifest.json", "defaultEnabled": true },
                { "id": "hosty.shell", "manifestRef": "apps/duplicate/manifest.json" },
                { "id": "Bad Id!", "manifestRef": "apps/bad/manifest.json" },
                { "id": "hosty.no-manifest" },
                { "id": "hosty.bad-feed", "manifestRef": "apps/feed/manifest.json", "feedsUrl": "ftp://example.test/feeds.json" }
              ]
            }
            """);

        var result = await CreateProvider(path).LoadAsync();

        Assert.Equal(["hosty.shell", "hosty.bad-feed"], result.Apps.Select(entry => entry.Id));
        // The invalid feed reference is dropped from the surviving entry, loudly.
        Assert.Null(result.Apps[1].FeedsUrl);
        Assert.Contains(result.Problems, problem => problem.Contains("more than once", StringComparison.Ordinal));
        Assert.Contains(result.Problems, problem => problem.Contains("Bad Id!", StringComparison.Ordinal));
        Assert.Contains(result.Problems, problem => problem.Contains("hosty.no-manifest", StringComparison.Ordinal));
        Assert.Contains(result.Problems, problem => problem.Contains("non-http(s) feedsUrl", StringComparison.Ordinal));
    }

    [Fact]
    public async Task LoadAsync_NothingFound_UsesEmbeddedDefault()
    {
        // Walk roots pinned to an empty temp dir so the repo's own distribution-apps.json is unreachable.
        Directory.CreateDirectory(root);
        var provider = new DistributionAppsProvider(
            NullLogger<DistributionAppsProvider>.Instance,
            explicitPathOverride: null,
            walkRoots: [root]);

        var result = await provider.LoadAsync();

        Assert.Equal("embedded default", result.Source);
        Assert.Empty(result.Problems);
        Assert.Equal(3, result.Apps.Count);
        Assert.All(result.Apps, entry => Assert.StartsWith("https://", entry.ManifestRef, StringComparison.Ordinal));
        Assert.False(result.Apps.Single(entry => entry.Id == "hosty.telemetry").DefaultEnabled);
    }

    [Fact]
    public async Task LoadAsync_WalksUpToFindListFile()
    {
        var nested = Path.Combine(root, "deeply", "nested", "bin");
        Directory.CreateDirectory(nested);
        WriteList("""
            {
              "schemaVersion": "distribution-apps.0.1",
              "apps": [ { "id": "hosty.shell", "manifestRef": "apps/shell/manifest.json", "defaultEnabled": true } ]
            }
            """);
        var provider = new DistributionAppsProvider(
            NullLogger<DistributionAppsProvider>.Instance,
            explicitPathOverride: null,
            walkRoots: [nested]);

        var result = await provider.LoadAsync();

        Assert.Empty(result.Problems);
        var entry = Assert.Single(result.Apps);
        Assert.Equal(Path.GetFullPath(Path.Combine(root, "apps", "shell", "manifest.json")), entry.ManifestRef);
    }

    // Walk roots are pinned inside the test directory so a fall-through can never wander up and find
    // the repository's own distribution-apps.json (tests run from within the repo tree).
    private DistributionAppsProvider CreateProvider(string path)
        => new(NullLogger<DistributionAppsProvider>.Instance, explicitPathOverride: path, walkRoots: [Path.Combine(root, "walk-isolation")]);

    private string WriteList(string json)
    {
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, DistributionAppsSchema.FileName);
        File.WriteAllText(path, json);
        return path;
    }

    public void Dispose()
    {
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
