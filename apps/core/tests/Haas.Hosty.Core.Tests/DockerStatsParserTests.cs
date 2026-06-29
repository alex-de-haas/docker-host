using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class DockerStatsParserTests
{
    [Fact]
    public void Parse_ReadsTabSeparatedStatLines()
    {
        const string output = "hosty-app-web\t0.50%\t12.3MiB / 1.94GiB\t0.62%\n" +
                              "hosty-app-db\t1.20%\t45MiB / 1.94GiB\t2.27%";

        var stats = DockerStatsParser.Parse(output);

        Assert.Equal(2, stats.Count);

        var web = stats[0];
        Assert.Equal("hosty-app-web", web.ContainerName);
        Assert.Equal(0.5, web.CpuPercent);
        Assert.Equal(12.3 * 1024 * 1024, web.MemoryBytes);
        Assert.Equal(0.62, web.MemoryPercent);

        Assert.Equal(45d * 1024 * 1024, stats[1].MemoryBytes);
    }

    [Theory]
    [InlineData("0%", 0d)]
    [InlineData("3.14%", 3.14d)]
    [InlineData(" 7.5% ", 7.5d)]
    public void ParsePercent_ParsesTrailingPercent(string value, double expected)
        => Assert.Equal(expected, DockerStatsParser.ParsePercent(value));

    [Theory]
    [InlineData("--")]
    [InlineData("")]
    [InlineData("   ")]
    public void ParsePercent_NullForMissingCells(string value)
        => Assert.Null(DockerStatsParser.ParsePercent(value));

    [Theory]
    [InlineData("512B", 512d)]
    [InlineData("1KiB", 1024d)]
    [InlineData("2MiB", 2d * 1024 * 1024)]
    [InlineData("1.5GiB", 1.5d * 1024 * 1024 * 1024)]
    [InlineData("100MB", 100d * 1000 * 1000)]
    [InlineData("2mib", 2d * 1024 * 1024)]
    public void ParseUsedBytes_SingleValue(string value, double expected)
        => Assert.Equal(expected, DockerStatsParser.ParseUsedBytes(value));

    [Fact]
    public void ParseUsedBytes_TakesUsedHalfBeforeSlash()
        => Assert.Equal(64d * 1024 * 1024, DockerStatsParser.ParseUsedBytes("64MiB / 2GiB"));

    [Fact]
    public void ParseUsedBytes_NullForUnparseable()
        => Assert.Null(DockerStatsParser.ParseUsedBytes("n/a"));

    [Fact]
    public void Parse_SkipsBlankLines()
        => Assert.Empty(DockerStatsParser.Parse("\n   \n"));

    [Fact]
    public void Parse_NameOnlyLineStillYieldsRecord()
    {
        var stat = Assert.Single(DockerStatsParser.Parse("hosty-app-web"));

        Assert.Equal("hosty-app-web", stat.ContainerName);
        Assert.Null(stat.CpuPercent);
        Assert.Null(stat.MemoryBytes);
    }
}
