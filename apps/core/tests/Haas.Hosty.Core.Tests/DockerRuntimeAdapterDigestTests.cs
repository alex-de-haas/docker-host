using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class DockerRuntimeAdapterTests
{
    [Theory]
    [InlineData(false, "arm64", true)]
    [InlineData(true, "arm64", false)]
    [InlineData(false, "amd64", false)]
    public async Task CredentialedReadinessRequiresAnExactPullAndMatchingDaemonPlatform(bool missing, string architecture, bool ready)
    {
        var digest = "sha256:" + new string('a', 64);
        var image = new RuntimeDockerImage("private.example.test/app", "", digest);
        var runner = new FakeDockerCommandRunner(args => args[0] switch
        {
            "version" => new(0, "linux/arm64", ""),
            "pull" when missing => new(1, "", "manifest unknown"),
            "pull" => new(0, "", ""),
            "image" => new(0, "{\"Os\":\"linux\",\"Architecture\":\"" + architecture + "\",\"RepoDigests\":[\"" + image.Reference + "\"]}", ""),
            _ => throw new InvalidOperationException("Unexpected lifecycle command")
        });
        var result = await CreateAdapter(runner).CheckImageAsync(image, default);
        Assert.Equal(ready, result.Ready);
        Assert.Equal(new[] { "pull", "--platform", "linux/arm64", image.Reference }, Assert.Single(runner.Commands, c => c[0] == "pull"));
        Assert.DoesNotContain(runner.Commands, c => c[0] is "run" or "stop" or "rm");
    }

    [Fact]
    public async Task AuthoredDigestPreparationPullsOnlyTheExactReference()
    {
        var digest = "sha256:" + new string('c', 64);
        var image = new RuntimeDockerImage("registry.example.test/team/app", "", digest);
        var context = CreateDockerContext(CreateDockerAppRecord(null, null));
        context = context with { Manifest = context.Manifest with
        {
            Services = [context.Manifest.Services[0] with { Image = image }],
        } };
        var runner = new FakeDockerCommandRunner(args => args is ["image", "inspect", ..]
            ? new(1, "", "missing") : new(0, "", ""));
        var preparation = await CreateAdapter(runner).PrepareAsync(context, default);
        Assert.Equal(digest, preparation.Artifacts["app"].ImageDigest);
        Assert.Equal(new[] { "pull", image.Reference }, Assert.Single(runner.Commands, c => c[0] == "pull"));
        Assert.DoesNotContain(runner.Commands, c => c[0] is "run" or "stop" or "rm");
    }

    [Fact]
    public async Task DigestProbeRejectsRegistrySubstitution()
    {
        var expected = "sha256:" + new string('a', 64);
        var unexpected = "sha256:" + new string('b', 64);
        var runner = new FakeDockerCommandRunner(_ => new(0, unexpected, ""));
        var resolved = await CreateAdapter(runner, registryDigestResolver: new StubRegistryDigestResolver(unexpected))
            .ResolveRemoteDigestAsync(new RuntimeDockerImage("example/app", "", expected));
        Assert.Null(resolved);
    }

    [Fact]
    public async Task DigestProbeUsesDigestReferenceInDockerFallback()
    {
        var digest = "sha256:" + new string('d', 64);
        var image = new RuntimeDockerImage("example/app", "", digest);
        var runner = new FakeDockerCommandRunner(_ => new(0, digest, ""));
        Assert.Equal(digest, await CreateAdapter(runner).ResolveRemoteDigestAsync(image));
        Assert.Equal(image.Reference, Assert.Single(runner.Commands)[^1]);
    }
}
