using System.Text.Json;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class ManifestWorkspaceSourcesTests : IDisposable
{
    private const string ApiSource = """{"type":"git","repository":"https://example.test/team/api.git","branch":"release","manifestPath":"apps/portal/manifest.json"}""";
    private const string WebSource = """{"type":"git","repository":"https://example.test/team/web.git","branch":"trunk"}""";
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-workspace-sources-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task NamedSourcesNormalizePrimaryWithoutEmittingLegacySource()
    {
        var json = DockerManifest($$"""
            "sources":{"web":{{WebSource}},"api":{{ApiSource}}},"primarySource":"api",
            """, """
            "sourceRef":"web",
            """);
        var selection = await Load(json);
        Assert.Equal(json, selection.ManifestJson);
        Assert.Equal("api", selection.Manifest.PrimarySource);
        Assert.Equal("web", Assert.Single(selection.Manifest.Services).SourceRef);
        var sources = Assert.IsAssignableFrom<IReadOnlyDictionary<string, RuntimeAppSource>>(selection.Manifest.Sources);
        Assert.Same(sources["api"], selection.Manifest.Source);
        Assert.Equal("apps/portal/manifest.json", selection.Manifest.Source!.ManifestPath);
        Assert.Equal("trunk", sources["web"].Branch);

        using var serialized = JsonDocument.Parse(CoreJson.Text(selection.Manifest));
        Assert.False(serialized.RootElement.TryGetProperty("source", out _));
        Assert.True(serialized.RootElement.TryGetProperty("sources", out _));
    }

    [Fact]
    public async Task LegacyAndImageOnlyManifestsKeepExistingSourceBehavior()
    {
        var legacyJson = DockerManifest($$"""
            "source":{{ApiSource}},
            """);
        var legacy = await Load(legacyJson);
        Assert.Equal(legacyJson, legacy.ManifestJson);
        Assert.Equal("release", legacy.Manifest.Source!.Branch);
        Assert.Null(legacy.Manifest.Sources);
        using var serialized = JsonDocument.Parse(CoreJson.Text(legacy.Manifest));
        Assert.True(serialized.RootElement.TryGetProperty("source", out _));
        Assert.False(serialized.RootElement.TryGetProperty("sources", out _));

        var editingOnly = await Load(DockerManifest($$"""
            "sources":{"web":{{WebSource}}},
            """, """
            "sourceRef":"web",
            """));
        Assert.Null(editingOnly.Manifest.Source);
        Assert.Null((await Load(DockerManifest())).Manifest.Source);
    }

    [Theory]
    [InlineData(""" "source":null,"sources":{"web":{"type":"git","repository":"https://example.test/web.git"}}, """,
        "", "app_manifest_sources_conflict")]
    [InlineData(""" "source":{"type":"git","repository":"https://example.test/web.git"},"sources":null, """,
        "", "app_manifest_sources_conflict")]
    [InlineData(""" "sources":{}, """, "", "app_manifest_sources_required")]
    [InlineData(""" "sources":{"web":null}, """, "", "app_manifest_named_source_invalid")]
    [InlineData(""" "sources":{"web":{"type":"git"}}, """, "", "app_manifest_named_source_invalid")]
    [InlineData(""" "sources":{"web":{"type":"git","repository":"ssh://example.test/web.git"}}, """,
        "", "app_manifest_named_source_invalid")]
    [InlineData(""" "sources":{"web":{"type":"git","repository":"https://example.test/web.git","paths":["../other"]}}, """,
        "", "app_manifest_source_path_invalid")]
    [InlineData(""" "sources":{"web":{"type":"git","repository":"https://example.test/web.git"}},"primarySource":"api", """,
        "", "app_manifest_primary_source_unknown")]
    [InlineData(""" "sources":{"web":{"type":"git","repository":"https://example.test/web.git"}}, """,
        """ "sourceRef":"api", """, "app_manifest_service_source_unknown")]
    [InlineData("", """ "sourceRef":"web", """, "app_manifest_service_source_unknown")]
    public async Task InvalidDeclarationsFailManifestAdmission(string sourceProperties, string serviceProperties, string code)
    {
        var error = await Assert.ThrowsAsync<AppManifestException>(() => Load(DockerManifest(sourceProperties, serviceProperties)));
        Assert.Contains(error.Errors, item => item.Code == code);
    }

    [Fact]
    public async Task NativeReleaseRequiresPrimaryAndReadsItsCommit()
    {
        var commit = new string('a', 40);
        var source = $$"""{"type":"git","repository":"https://example.test/team/api.git","commit":"{{commit}}"}""";
        var json = $$"""
            {
              "schemaVersion":"app.0.2","id":"org.unrelated.portal","name":"Portal","version":"1.0.0",
              "sources":{"api":{{source}},"web":{{WebSource}}},"primarySource":"api",
              "runtimeProfiles":[{"key":"local","type":"localCommand","default":true}],
              "services":[{"key":"app","sourceRef":"api","runtimes":{"local":{"command":"./start"} } }]
            }
            """;
        var published = await Load(json);
        Assert.Equal(commit, published.Manifest.Source!.Commit);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => Load(json.Replace(
            ""","primarySource":"api" """.TrimEnd(), "", StringComparison.Ordinal)));
        Assert.Contains(error.Errors, item => item.Code == "app_manifest_primary_source_required");
    }

    [Fact]
    public async Task RepositoryAndServiceBindingChangesRequireReview()
    {
        var original = await Load(DockerManifest($$"""
            "sources":{"web":{{WebSource}},"api":{{ApiSource}}},"primarySource":"api",
            """, """
            "sourceRef":"web",
            """));
        var reordered = await Load(DockerManifest($$"""
            "sources":{"api":{{ApiSource}},"web":{{WebSource}}},"primarySource":"api",
            """, """
            "sourceRef":"web",
            """));
        Assert.False(AppManifestService.WorkspaceSourcesChanged(original.Manifest, reordered.Manifest));

        var pinnedApi = ApiSource[..^1] + $$""","commit":"{{new string('a', 40)}}","tag":"v1.1.0"}""";
        var pinned = await Load(original.ManifestJson.Replace(ApiSource, pinnedApi, StringComparison.Ordinal));
        Assert.False(AppManifestService.WorkspaceSourcesChanged(original.Manifest, pinned.Manifest));

        var redirected = await Load(original.ManifestJson.Replace("team/web.git", "team/new-web.git", StringComparison.Ordinal));
        var reassigned = await Load(original.ManifestJson.Replace(
            """ "sourceRef":"web" """.Trim(), """ "sourceRef":"api" """.Trim(), StringComparison.Ordinal));
        var retargeted = await Load(original.ManifestJson.Replace("trunk", "next", StringComparison.Ordinal));
        var manifestMoved = await Load(original.ManifestJson.Replace("apps/portal/manifest.json", "portal/manifest.json", StringComparison.Ordinal));
        Assert.True(AppManifestService.WorkspaceSourcesChanged(original.Manifest, redirected.Manifest));
        Assert.True(AppManifestService.WorkspaceSourcesChanged(original.Manifest, reassigned.Manifest));
        Assert.True(AppManifestService.WorkspaceSourcesChanged(original.Manifest, retargeted.Manifest));
        Assert.True(AppManifestService.WorkspaceSourcesChanged(original.Manifest, manifestMoved.Manifest));
    }

    private static string DockerManifest(string sourceProperties = "", string serviceProperties = "") => $$"""
        {
          "schemaVersion":"app.0.1","id":"org.unrelated.portal","name":"Portal","version":"1.0.0",
          {{sourceProperties}}
          "runtimeProfiles":[{"key":"docker","type":"docker","default":true}],
          "services":[{"key":"app",{{serviceProperties}}"runtimes":{"docker":{"image":"example/portal:1.0.0"} } }]
        }
        """;

    private async Task<RuntimeAppManifestSelection> Load(string json)
    {
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, Guid.NewGuid().ToString("N") + ".json");
        await File.WriteAllTextAsync(path, json);
        return await new AppManifestService().LoadAsync(path);
    }

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
    }
}
