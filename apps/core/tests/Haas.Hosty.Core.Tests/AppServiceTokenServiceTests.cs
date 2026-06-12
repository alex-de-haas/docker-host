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

    [Fact]
    public void ResolveAppId_ReturnsAppIdForValidToken()
    {
        var service = new AppServiceTokenService(new ControlSecret("test-secret"));
        var token = service.CreateToken("com.example.app");

        Assert.Equal("com.example.app", service.ResolveAppId(token));
    }

    [Fact]
    public void ResolveAppId_RejectsTokenSignedWithDifferentSecret()
    {
        var issuer = new AppServiceTokenService(new ControlSecret("test-secret"));
        var validator = new AppServiceTokenService(new ControlSecret("other-secret"));
        var token = issuer.CreateToken("com.example.app");

        Assert.Null(validator.ResolveAppId(token));
    }

    [Fact]
    public void ResolveAppId_RejectsTokenWithTamperedAppId()
    {
        var service = new AppServiceTokenService(new ControlSecret("test-secret"));
        var parts = service.CreateToken("com.example.app").Split('.');
        var tamperedAppPart = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("com.example.other"))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var tampered = $"{parts[0]}.{parts[1]}.{tamperedAppPart}.{parts[3]}";

        Assert.Null(service.ResolveAppId(tampered));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-a-token")]
    [InlineData("hosty_app_service.1.only-three-parts")]
    [InlineData("hosty_app_service.1.!!!.signature")]
    public void ResolveAppId_RejectsMalformedTokens(string token)
    {
        var service = new AppServiceTokenService(new ControlSecret("test-secret"));

        Assert.Null(service.ResolveAppId(token));
    }
}
