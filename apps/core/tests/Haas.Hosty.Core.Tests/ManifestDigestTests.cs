using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class ManifestDigestTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-digest-contract-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task NewSchemaReadsAuthoredDigestWithoutInventingTag()
    {
        var digest = "sha256:" + new string('a', 64);
        var selection = await Load("app.0.2", $$"""{"repository":"registry.example.test/team/app","digest":"{{digest}}"}""");
        Assert.Equal(digest, selection.Services.Single().Image!.Digest);
        Assert.Equal("registry.example.test/team/app@" + digest, selection.Services.Single().Image!.Reference);
    }

    [Theory]
    [InlineData("\"example/app:latest\"")]
    [InlineData("{\"repository\":\"example/app\",\"tag\":\"latest\"}")]
    [InlineData("{\"repository\":\"example/app\",\"digest\":\"sha256:bad\"}")]
    public async Task NewSchemaCannotSilentlyFallBackToATag(string image)
        => await Assert.ThrowsAsync<AppManifestException>(() => Load("app.0.2", image));

    [Theory]
    [InlineData("example/app:latest")]
    [InlineData("example/app@sha256:foo")]
    [InlineData("example/../app")]
    public async Task NewSchemaRejectsAmbiguousRepositories(string repository)
        => await Assert.ThrowsAsync<AppManifestException>(() => Load("app.0.2",
            $$"""{"repository":"{{repository}}","digest":"sha256:{{new string('a', 64)}}"}"""));

    [Fact]
    public async Task LegacySchemaStillAcceptsTag()
    {
        var selection = await Load("app.0.1", "\"example/app:1.0.0\"");
        Assert.Equal("1.0.0", selection.Services.Single().Image!.Tag);
        Assert.Null(selection.Services.Single().Image!.Digest);
    }

    private async Task<RuntimeAppManifestSelection> Load(string schema, string image)
    {
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, Guid.NewGuid().ToString("N") + ".json");
        await File.WriteAllTextAsync(path, $$"""
            {"schemaVersion":"{{schema}}","id":"org.unrelated.notes","name":"Notes","version":"1.0.0",
            "runtimeProfiles":[{"key":"docker","type":"docker","default":true}],
            "services":[{
              "key":"app",
              "runtimes":{
                "docker":{"type":"docker","image":{{image}}}
              }
            }]
            }
            """);
        return await new AppManifestService().LoadAsync(path);
    }

    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }
}
