using Haas.Hosty.Launch;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreEnvironmentConsentTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-consent-closure-" + Guid.NewGuid().ToString("N"));
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }

    [Theory]
    [InlineData("native.so")]
    [InlineData("native.dylib")]
    [InlineData("appsettings.json")]
    [InlineData("runtime-content.dat")]
    public async Task CurrentConsentHashesEveryCopiedArtifact(string artifact)
    {
        var source = Path.Combine(root, "source"); var copy = Path.Combine(root, "copy");
        Directory.CreateDirectory(Path.Combine(source, "nested")); Directory.CreateDirectory(copy);
        await File.WriteAllTextAsync(Path.Combine(source, "hosty-core"), "unchanged executable");
        var file = Path.Combine(source, "nested", artifact); await File.WriteAllTextAsync(file, "original");
        var original = await CoreEnvironmentConsentService.CurrentDigestAsync(source, default);
        CoreEnvironmentRuntime.CopyDirectory(source, copy);
        Assert.Equal(original, await CoreEnvironmentConsentService.CurrentDigestAsync(copy, default));
        Assert.Equal("original", await File.ReadAllTextAsync(Path.Combine(copy, "nested", artifact)));

        await File.WriteAllTextAsync(file, "replacement");
        Assert.NotEqual(original, await CoreEnvironmentConsentService.CurrentDigestAsync(source, default));
        File.Delete(file);
        Assert.NotEqual(original, await CoreEnvironmentConsentService.CurrentDigestAsync(source, default));
    }

    [Fact]
    public async Task CurrentConsentIgnoresRegeneratedMarkersButPreservesTheCopiedTree()
    {
        var source = Path.Combine(root, "source"); var copy = Path.Combine(root, "copy");
        Directory.CreateDirectory(Path.Combine(source, "empty")); Directory.CreateDirectory(copy);
        await File.WriteAllTextAsync(Path.Combine(source, "hosty-core"), "same executable");
        var original = await CoreEnvironmentConsentService.CurrentDigestAsync(source, default);
        await File.WriteAllTextAsync(Path.Combine(source, CoreBuildRetention.Marker), "parent retention state");
        Assert.Equal(original, await CoreEnvironmentConsentService.CurrentDigestAsync(source, default));
        CoreEnvironmentRuntime.CopyDirectory(source, copy);
        Assert.True(Directory.Exists(Path.Combine(copy, "empty")));
        Assert.False(File.Exists(Path.Combine(copy, CoreBuildRetention.Marker)));
        Assert.Equal(original, await CoreEnvironmentConsentService.CurrentDigestAsync(copy, default));
    }
}
