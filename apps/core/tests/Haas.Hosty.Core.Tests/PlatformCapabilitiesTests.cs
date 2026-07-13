namespace Haas.Hosty.Core.Tests;

public sealed class PlatformCapabilitiesTests
{
    [Fact]
    public void StartPriority_KnownSlot_ReturnsRegisteredPriority()
        => Assert.Equal(100, PlatformCapabilities.StartPriority(["otlp-collector"]));

    [Fact]
    public void StartPriority_TakesMaxAcrossSlotsAndIgnoresUnknown()
        => Assert.Equal(100, PlatformCapabilities.StartPriority(["some-future-slot", "otlp-collector"]));

    [Theory]
    [InlineData]
    [InlineData("unknown-slot")]
    public void StartPriority_NoKnownSlot_IsZero(params string[] provides)
        => Assert.Equal(0, PlatformCapabilities.StartPriority(provides));

    [Fact]
    public void StartPriority_NullProvides_IsZero()
        => Assert.Equal(0, PlatformCapabilities.StartPriority(null));
}
