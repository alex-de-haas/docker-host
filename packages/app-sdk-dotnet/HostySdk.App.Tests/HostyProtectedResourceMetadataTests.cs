using HostySdk.App;
using Xunit;

namespace HostySdk.App.Tests;

public sealed class HostyProtectedResourceMetadataTests
{
    [Fact]
    public void BuildsFromExplicitValues_AndDerivesTheChallengeHeaderTheRfc9728Way()
    {
        var metadata = HostyProtectedResourceMetadata.TryBuild(
            resourceUrl: "https://notes.example.test/api/mcp",
            authorizationServerOrigin: "https://core.example.test/");

        Assert.NotNull(metadata);
        Assert.Equal("https://notes.example.test/api/mcp", metadata!.Resource);
        Assert.Equal("https://core.example.test", Assert.Single(metadata.AuthorizationServers));
        Assert.Equal(
            "Bearer resource_metadata=\"https://notes.example.test/.well-known/oauth-protected-resource/api/mcp\"",
            HostyProtectedResourceMetadata.BuildWwwAuthenticate(metadata));
    }

    [Fact]
    public void RefusesToGuessWhenEitherUrlIsMissing()
    {
        // No metadata is the ordinary state of an unpublished app, and it simply means the manual
        // token path — a guessed identity would have clients requesting tokens for a URL nothing
        // serves.
        Assert.Null(HostyProtectedResourceMetadata.TryBuild(
            resourceUrl: "https://notes.example.test/api/mcp",
            authorizationServerOrigin: "   "));
        Assert.Null(HostyProtectedResourceMetadata.TryBuild(
            resourceUrl: null,
            authorizationServerOrigin: "https://core.example.test"));
    }
}
