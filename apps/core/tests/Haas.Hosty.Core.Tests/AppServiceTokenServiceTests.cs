using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class AppServiceTokenServiceTests
{
    [Fact]
    public void ValidateToken_AcceptsTokenForSameApp()
    {
        var service = new AppServiceTokenService(new ControlSecret("test-secret"));
        var token = service.CreateToken("com.example.app");

        Assert.True(service.ValidateToken("com.example.app", token));
    }

    [Fact]
    public void ValidateToken_RejectsTokenForDifferentApp()
    {
        var service = new AppServiceTokenService(new ControlSecret("test-secret"));
        var token = service.CreateToken("com.example.app");

        Assert.False(service.ValidateToken("com.example.other", token));
    }

    [Fact]
    public void ValidateToken_RejectsMalformedToken()
    {
        var service = new AppServiceTokenService(new ControlSecret("test-secret"));

        Assert.False(service.ValidateToken("com.example.app", "not-a-token"));
    }
}
