using System.Text;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class DockerStatsExpositionTests
{
    [Fact]
    public void AppendSample_RendersPrometheusLineWithAttributionAndService()
    {
        var builder = new StringBuilder();
        DockerStatsExposition.AppendSample(builder, "container.cpu.percent", "com.acme.app", "web", 1.5);

        Assert.Equal("container.cpu.percent{hosty_app_id=\"com.acme.app\",service=\"web\"} 1.5\n", builder.ToString());
    }

    [Fact]
    public void AppendSample_EscapesLabelValues()
    {
        var builder = new StringBuilder();
        DockerStatsExposition.AppendSample(builder, "m", "a\"b", "c\\d", 2);

        Assert.Equal("m{hosty_app_id=\"a\\\"b\",service=\"c\\\\d\"} 2\n", builder.ToString());
    }

    [Fact]
    public void ParseContainerOwners_ReadsLabelsAndFallsBackToAppIdForService()
    {
        var owners = DockerStatsExposition.ParseContainerOwners(
            "cont-a\tcom.acme.app\tweb\ncont-b\tcom.acme.other\t\n");

        Assert.Equal(2, owners.Count);
        Assert.Equal(new ContainerStatOwner("com.acme.app", "web"), owners["cont-a"]);
        // No service label → falls back to the app id.
        Assert.Equal(new ContainerStatOwner("com.acme.other", "com.acme.other"), owners["cont-b"]);
    }

    [Fact]
    public void ParseContainerOwners_SkipsMalformedLines()
    {
        // Blank lines and a name-only line (no app id) carry no owner.
        var owners = DockerStatsExposition.ParseContainerOwners("\nonlyname\ngood\tapp\tsvc\n");
        var owner = Assert.Single(owners);
        Assert.Equal("good", owner.Key);
    }
}
