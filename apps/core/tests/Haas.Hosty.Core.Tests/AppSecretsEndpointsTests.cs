using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class AppSecretsEndpointsTests
{
    [Fact]
    public void ValidateKey_AcceptsADocumentedKeyShape()
        => Assert.Null(AppSecretsEndpoints.ValidateKey("trakt.connection.1.tokens"));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("Uppercase")]
    [InlineData(".leading-dot")]
    public void ValidateKey_RejectsMalformedKeys(string? key)
    {
        var error = AppSecretsEndpoints.ValidateKey(key);

        Assert.NotNull(error);
        Assert.Equal("app_secret_key_invalid", error.Code);
    }

    [Fact]
    public void ValidateWrite_AcceptsAKeyAndBoundedValue()
        => Assert.Null(AppSecretsEndpoints.ValidateWrite("key", "value"));

    [Fact]
    public void ValidateWrite_ReportsTheKeyErrorBeforeTheValueError()
    {
        var error = AppSecretsEndpoints.ValidateWrite("Bad Key", null);

        Assert.NotNull(error);
        Assert.Equal("app_secret_key_invalid", error.Code);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void ValidateWrite_RejectsMissingValues(string? value)
    {
        var error = AppSecretsEndpoints.ValidateWrite("key", value);

        Assert.NotNull(error);
        Assert.Equal("app_secret_value_invalid", error.Code);
    }

    [Fact]
    public void ValidateWrite_RejectsOversizeValues_WithoutTruncating()
    {
        var error = AppSecretsEndpoints.ValidateWrite("key", new string('a', AppSecretsStore.MaxValueBytes + 1));

        Assert.NotNull(error);
        Assert.Equal("app_secret_value_invalid", error.Code);
    }
}
