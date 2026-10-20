using Haas.Hosty.Core;
using ModelContextProtocol.Server;

namespace Haas.Hosty.Core.Tests;

public sealed class WorkspaceActivationMcpSchemaTests
{
    [Fact]
    public void SchemaGenerationNeedsNoSchemaTimeServicesAndExposesOnlyTypedCallerInputs()
    {
        var method = typeof(WorkspaceActivationMcpTools).GetMethod(nameof(WorkspaceActivationMcpTools.Run))!;
        var tool = McpServerTool.Create(method,
            createTargetFunc: _ => throw new InvalidOperationException("Generating a schema must not instantiate invocation services."),
            options: new() { SerializerOptions = CoreJsonSerializerContext.Default.Options });
        var properties = tool.ProtocolTool.InputSchema.GetProperty("properties");
        Assert.Equal(new[] { "input", "kind", "workspaceId" }, properties.EnumerateObject().Select(p => p.Name).Order(StringComparer.Ordinal));
        Assert.True(properties.GetProperty("input").GetProperty("properties").TryGetProperty("selection", out _));
    }
}
