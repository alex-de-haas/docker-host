using Haas.Hosty.Core;
using Microsoft.Extensions.Configuration;

namespace Haas.Hosty.Core.Tests;

public sealed class SourceProviderTests
{
    [Fact]
    public void RegistryResolvesExplicitProviderAndRepositoryHostWithoutSelectingAccount()
    {
        using var client = new HttpClient();
        ISourceProvider github = new GitHubSourceProvider(client, new ConfigurationBuilder().Build(), new SystemClock());
        var registry = new SourceProviderRegistry([github]);
        Assert.Same(github, registry.Resolve("github"));
        Assert.Same(github, registry.ForUrl("https://github.com/team/repo.git"));
        Assert.Equal("github", Assert.Single(registry.Descriptors).Id);
        Assert.Contains("device", github.Descriptor.AuthenticationMethods);
        Assert.Contains("pull-requests", github.Descriptor.Capabilities);
        Assert.NotNull(github.Publication);
        Assert.Throws<ArgumentException>(() => new SourceProviderRegistry([github, github]));
        Assert.Throws<AppLifecycleException>(() => registry.ForUrl("https://github.com.evil.test/team/repo.git"));
        Assert.Throws<AppLifecycleException>(() => registry.ForUrl("https://dev.azure.com/team/repo"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("azure-devops")]
    [InlineData("missing")]
    public void UnknownOrMissingProviderIsAnActionableError(string? id)
    {
        var registry = new SourceProviderRegistry([]);
        var error = Assert.Throws<UserConnectionException>(() => registry.Resolve(id));
        Assert.Equal("provider_unsupported", error.Code);
        Assert.Equal(409, error.Status);
    }
}
