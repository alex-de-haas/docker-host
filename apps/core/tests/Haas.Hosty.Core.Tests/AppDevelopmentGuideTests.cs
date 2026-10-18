using System.Text;
using System.Text.Json;

namespace Haas.Hosty.Core.Tests;

public sealed class AppDevelopmentGuideTests
{
    [Fact]
    public void PackagedTopicsAreBoundedVersionedAndAotSerializable()
    {
        var overview = AppDevelopmentGuideReader.Read();
        Assert.Equal("overview", overview.Topic);
        Assert.Equal("app.0.1", overview.ManifestSchema);
        Assert.Equal(CoreStatusResponse.PlatformVersionString, overview.CoreVersion);
        Assert.Matches("^[a-f0-9]{64}$", overview.Revision);
        Assert.Equal(8, overview.Topics.Count);
        Assert.Equal(overview.Topics.Count, overview.Topics.Select(t => t.Id).Distinct().Count());
        foreach (var topic in overview.Topics)
        {
            var guide = AppDevelopmentGuideReader.Read(topic.Id);
            Assert.Equal(topic.Id, guide.Topic);
            Assert.Equal(overview.Revision, guide.Revision);
            Assert.StartsWith("# ", guide.Text);
            Assert.InRange(Encoding.UTF8.GetByteCount(guide.Text), 1, AppDevelopmentGuideReader.MaximumTopicBytes);
            using var json = JsonDocument.Parse(CoreJson.Text(guide));
            Assert.Equal(guide.Text, json.RootElement.GetProperty("text").GetString());
            Assert.True(Encoding.UTF8.GetByteCount(CoreJson.Text(guide)) < 24_000);
        }
    }

    [Theory]
    [InlineData("")]
    [InlineData("all")]
    [InlineData("../AppBootstrap/auth.ts")]
    [InlineData("OVERVIEW")]
    public void UnknownTopicsDoNotReadFilesOrExpandTheGuide(string topic)
    {
        var error = Assert.Throws<AppLifecycleException>(() => AppDevelopmentGuideReader.Read(topic));
        Assert.Equal(AppDevelopmentGuideReader.InvalidTopicCode, error.Code);
    }
}
