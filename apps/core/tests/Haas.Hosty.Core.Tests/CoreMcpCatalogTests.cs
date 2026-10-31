using System.Text.Json;
using System.Text.Json.Nodes;
using ModelContextProtocol.Protocol;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreMcpCatalogTests
{
    [Fact]
    public void DecorationPreservesSchemasAndForeignMetadataWithoutMutatingTheSdkDescriptor()
    {
        var source = new Tool
        {
            Name = "get_app", Description = "fixture",
            InputSchema = JsonDocument.Parse("""{"type":"object","properties":{"appId":{"type":"string"}},"required":["appId"]}""").RootElement.Clone(),
            OutputSchema = JsonDocument.Parse("""{"type":"object","properties":{"id":{"type":"string"}}}""").RootElement.Clone(),
            Annotations = new() { ReadOnlyHint = true },
            Meta = new JsonObject
            {
                ["com.example/extension"] = new JsonObject { ["retained"] = true },
                [CoreMcpCatalog.MetadataKey] = new JsonObject { ["owner"] = "untrusted-owner" },
            },
        };
        var before = CoreJson.Text(source);

        var first = CoreMcpCatalog.Describe(source);
        first.Meta!["com.example/extension"]!["retained"] = false;
        var second = CoreMcpCatalog.Describe(source);

        Assert.Equal(before, CoreJson.Text(source));
        Assert.Equal(source.InputSchema.GetRawText(), second.InputSchema.GetRawText());
        Assert.Equal(source.OutputSchema!.Value.GetRawText(), second.OutputSchema!.Value.GetRawText());
        Assert.True(second.Annotations!.ReadOnlyHint);
        Assert.True(second.Meta!["com.example/extension"]!["retained"]!.GetValue<bool>());
        Assert.Equal(AgentMcpDirectory.CoreId, second.Meta[CoreMcpCatalog.MetadataKey]!["owner"]!.GetValue<string>());
        Assert.Equal("apps", second.Meta[CoreMcpCatalog.MetadataKey]!["feature"]!["id"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("get_workspace", "workspaces", "mcp:workspaces", true)]
    [InlineData("get_workspace_diff", "git", "mcp:workspaces", true)]
    [InlineData("get_app_dev_mode", "development", "mcp:lifecycle", false)]
    public void ReadOnlyHintsDoNotReduceDeclaredAuthority(string name, string feature, string scope, bool directOnly)
    {
        var tool = CoreMcpCatalog.Describe(new Tool
        {
            Name = name, InputSchema = JsonDocument.Parse("""{"type":"object"}""").RootElement.Clone(),
            Annotations = new() { ReadOnlyHint = true },
        });
        var metadata = tool.Meta![CoreMcpCatalog.MetadataKey]!;
        Assert.Equal(feature, metadata["feature"]!["id"]!.GetValue<string>());
        Assert.Contains(metadata["authority"]!["directScopes"]!.AsArray(), value => value!.GetValue<string>() == scope);
        Assert.Equal(directOnly, metadata["authority"]!["directOnly"]!.GetValue<bool>());
        Assert.Null(metadata["authority"]!["appPermission"]);
    }

    [Fact]
    public void UnknownNamesCannotBorrowAPrefixOrAnAppPermission()
    {
        Assert.Null(CoreMcpCatalog.AppPermission("get_app_private_history"));
        Assert.Null(CoreMcpCatalog.AppPermission("list_workspaces"));
        Assert.Equal(CoreAppPermissions.ReadApps, CoreMcpCatalog.AppPermission("get_app"));
        Assert.Throws<InvalidOperationException>(() => CoreMcpCatalog.Describe(new Tool
        {
            Name = "get_app_private_history", InputSchema = JsonDocument.Parse("""{"type":"object"}""").RootElement.Clone(),
            Annotations = new() { ReadOnlyHint = true },
        }));
    }
}
