using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class CloudflareTunnelConfigPatcherTests
{
    // Shaped like the phase-0 spike's real config: multiple ingress rules, per-rule originRequest, a final
    // catch-all, and a top-level `warp-routing` sibling key that must survive every patch.
    private static JsonObject Sample() => (JsonObject)JsonNode.Parse("""
        {
          "ingress": [
            {"hostname":"media.example.test","service":"http://localhost:8096","originRequest":{"connectTimeout":30}},
            {"hostname":"core.example.test","service":"http://localhost:3001"},
            {"service":"http_status:404"}
          ],
          "warp-routing": {"enabled": true},
          "originRequest": {"noTLSVerify": false}
        }
        """)!;

    [Fact]
    public void UpsertIngress_NewHostname_InsertsBeforeCatchAll_AndPreservesEverythingElse()
    {
        var result = CloudflareTunnelConfigPatcher.UpsertIngress(Sample(), "app.example.test", "http://localhost:4000");

        var ingress = (JsonArray)result["ingress"]!;
        Assert.Equal(4, ingress.Count);
        // New rule sits immediately before the catch-all, preserving the existing order.
        Assert.Equal("media.example.test", (string?)ingress[0]!["hostname"]);
        Assert.Equal("core.example.test", (string?)ingress[1]!["hostname"]);
        Assert.Equal("app.example.test", (string?)ingress[2]!["hostname"]);
        Assert.Equal("http://localhost:4000", (string?)ingress[2]!["service"]);
        Assert.Null(ingress[3]!["hostname"]); // catch-all still last
        Assert.Equal("http_status:404", (string?)ingress[3]!["service"]);
        // Sibling top-level keys and per-rule originRequest survive.
        Assert.True((bool)result["warp-routing"]!["enabled"]!);
        Assert.False((bool)result["originRequest"]!["noTLSVerify"]!);
        Assert.Equal(30, (int)ingress[0]!["originRequest"]!["connectTimeout"]!);
    }

    [Fact]
    public void UpsertIngress_ExistingHostname_UpdatesServiceOnly_KeepingOriginRequest()
    {
        var result = CloudflareTunnelConfigPatcher.UpsertIngress(Sample(), "media.example.test", "http://localhost:9999");

        var ingress = (JsonArray)result["ingress"]!;
        Assert.Equal(3, ingress.Count); // no new rule
        Assert.Equal("http://localhost:9999", (string?)ingress[0]!["service"]);
        Assert.Equal(30, (int)ingress[0]!["originRequest"]!["connectTimeout"]!); // preserved
    }

    [Fact]
    public void RemoveIngress_RemovesOnlyThatRule_KeepingCatchAllAndSiblings()
    {
        var result = CloudflareTunnelConfigPatcher.RemoveIngress(Sample(), "core.example.test");

        var hostnames = CloudflareTunnelConfigPatcher.IngressHostnames(result);
        Assert.Equal(["media.example.test"], hostnames);
        Assert.True((bool)result["warp-routing"]!["enabled"]!);
        Assert.Equal("http_status:404", (string?)((JsonArray)result["ingress"]!)[^1]!["service"]);
    }

    [Fact]
    public void Patch_DoesNotMutateTheInputDocument()
    {
        var input = Sample();
        _ = CloudflareTunnelConfigPatcher.UpsertIngress(input, "app.example.test", "http://localhost:4000");
        _ = CloudflareTunnelConfigPatcher.RemoveIngress(input, "media.example.test");

        Assert.Equal(3, ((JsonArray)input["ingress"]!).Count); // untouched
    }

    [Fact]
    public void UpsertIngress_BlankHostnameOrService_Throws()
    {
        Assert.Throws<ArgumentException>(() => CloudflareTunnelConfigPatcher.UpsertIngress(Sample(), "  ", "http://localhost:1"));
        Assert.Throws<ArgumentException>(() => CloudflareTunnelConfigPatcher.UpsertIngress(Sample(), "app.example.test", ""));
    }

    [Fact]
    public void RemoveIngress_BlankHostname_DoesNotTouchCatchAll()
    {
        // A blank hostname is rejected rather than matching the hostname-less catch-all.
        Assert.Throws<ArgumentException>(() => CloudflareTunnelConfigPatcher.RemoveIngress(Sample(), " "));
    }

    [Fact]
    public void IngressHostnames_ExcludesTheCatchAll()
        => Assert.Equal(["media.example.test", "core.example.test"], CloudflareTunnelConfigPatcher.IngressHostnames(Sample()));

    [Fact]
    public void UpsertIngress_NoCatchAll_AppendsAtTheEnd()
    {
        // Without a catch-all to insert before, the rule is appended. Covers the append branch, which is
        // the one that had to avoid JsonArray's trim/AOT-unsafe generic Add<T>.
        var config = (JsonObject)JsonNode.Parse("""
            {"ingress":[{"hostname":"media.example.test","service":"http://localhost:8096"}]}
            """)!;

        var result = CloudflareTunnelConfigPatcher.UpsertIngress(config, "app.example.test", "http://localhost:4000");

        var ingress = (JsonArray)result["ingress"]!;
        Assert.Equal(2, ingress.Count);
        Assert.Equal("media.example.test", (string?)ingress[0]!["hostname"]);
        // Appended as a real object node, not a serialized value wrapper.
        var appended = Assert.IsType<JsonObject>(ingress[1]);
        Assert.Equal("app.example.test", (string?)appended["hostname"]);
        Assert.Equal("http://localhost:4000", (string?)appended["service"]);
    }

    [Fact]
    public void UpsertIngress_MissingIngressArray_SynthesizesCatchAllAndInserts()
    {
        var config = (JsonObject)JsonNode.Parse("""{"warp-routing":{"enabled":true}}""")!;
        var result = CloudflareTunnelConfigPatcher.UpsertIngress(config, "app.example.test", "http://localhost:4000");

        var ingress = (JsonArray)result["ingress"]!;
        Assert.Equal("app.example.test", (string?)ingress[0]!["hostname"]);
        Assert.Equal("http_status:404", (string?)ingress[1]!["service"]); // synthesized catch-all last
        Assert.True((bool)result["warp-routing"]!["enabled"]!);
    }
}
