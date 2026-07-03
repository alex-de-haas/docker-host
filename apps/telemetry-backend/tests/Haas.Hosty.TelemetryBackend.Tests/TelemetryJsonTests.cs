using Xunit;
using Haas.Hosty.TelemetryBackend;

namespace Haas.Hosty.TelemetryBackend.Tests;

public sealed class TelemetryJsonTests
{
    [Fact]
    public void SerializeStringMap_SortsKeysOrdinal()
    {
        var map = new Dictionary<string, string> { ["b"] = "2", ["a"] = "1", ["c"] = "3" };
        Assert.Equal("{\"a\":\"1\",\"b\":\"2\",\"c\":\"3\"}", TelemetryJson.SerializeStringMap(map));
    }

    [Fact]
    public void SerializeStringMap_EmptyIsEmptyObject()
        => Assert.Equal("{}", TelemetryJson.SerializeStringMap(new Dictionary<string, string>()));

    [Fact]
    public void RoundTrip_PreservesEntries()
    {
        var map = new Dictionary<string, string> { ["service"] = "web", ["region"] = "eu" };
        var back = TelemetryJson.DeserializeStringMap(TelemetryJson.SerializeStringMap(map));
        Assert.Equal(2, back.Count);
        Assert.Equal("web", back["service"]);
        Assert.Equal("eu", back["region"]);
    }

    [Fact]
    public void Serialize_EscapesQuotesAndControlChars()
    {
        var map = new Dictionary<string, string> { ["k"] = "a\"b\nc" };
        var back = TelemetryJson.DeserializeStringMap(TelemetryJson.SerializeStringMap(map));
        Assert.Equal("a\"b\nc", back["k"]);
    }

    [Fact]
    public void Deserialize_MalformedReturnsEmpty()
    {
        Assert.Empty(TelemetryJson.DeserializeStringMap("not json"));
        Assert.Empty(TelemetryJson.DeserializeStringMap(null));
        Assert.Empty(TelemetryJson.DeserializeStringMap("{}"));
    }
}
