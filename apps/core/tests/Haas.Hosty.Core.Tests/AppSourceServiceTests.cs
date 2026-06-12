using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class AppSourceServiceTests
{
    [Theory]
    [InlineData("https://github.com/example/app.git")]
    [InlineData("http://git.example.test/app.git")]
    [InlineData("/srv/git/app.git")]
    public void ValidateManagedRepository_AcceptsSupportedRepositories(string repository)
        => AppSourceService.ValidateManagedRepository(repository);

    [Theory]
    [InlineData("--upload-pack=/bin/sh", "source_repository_invalid")]
    [InlineData("-o, something", "source_repository_invalid")]
    [InlineData("git@github.com:example/app.git", "source_repository_scheme_unsupported")]
    [InlineData("ssh://git@github.com/example/app.git", "source_repository_scheme_unsupported")]
    [InlineData("https://user:secret@github.com/example/app.git", "source_repository_credentials_unsupported")]
    public void ValidateManagedRepository_RejectsUnsafeRepositories(string repository, string expectedCode)
    {
        var error = Assert.Throws<AppLifecycleException>(() => AppSourceService.ValidateManagedRepository(repository));

        Assert.Equal(expectedCode, error.Code);
    }
}
