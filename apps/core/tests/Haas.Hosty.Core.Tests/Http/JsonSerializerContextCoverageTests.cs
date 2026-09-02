using System.Reflection;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// The guardrail for the failure that took a released Core down: a request-body record reachable from a
// mapped endpoint but missing its [JsonSerializable] entry in CoreJsonSerializerContext.
//
// Why no existing test caught it. ConfigureServices *inserts* the source-generated context at the head
// of the resolver chain, so under the JIT test host the reflection-based default resolver still sits
// behind it and answers for an unregistered type. The published Native AOT binary has no reflection
// resolver at all — the chain holds the context alone — so the same route table that builds here throws
// there. And it throws while BUILDING the table, inside the routing middleware's lazy initialization:
// one unregistered body type takes down every endpoint, not just its own.
//
// So this asserts against the context directly rather than through the pipeline: a chain that can fall
// back is exactly what hides the defect.
public sealed class JsonSerializerContextCoverageTests
{
    [Fact]
    public async Task EveryMappedRequestBodyType_IsRegisteredInTheSourceGeneratedContext()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var source = harness.Services.GetRequiredService<EndpointDataSource>();
        var coreAssembly = typeof(CoreJsonSerializerContext).Assembly;

        var missing = new SortedSet<string>(StringComparer.Ordinal);
        var checkedTypes = 0;
        foreach (var endpoint in source.Endpoints.OfType<RouteEndpoint>())
        {
            if (endpoint.Metadata.GetMetadata<MethodInfo>() is not { } handler)
            {
                continue;
            }

            foreach (var parameter in handler.GetParameters())
            {
                var type = Nullable.GetUnderlyingType(parameter.ParameterType) ?? parameter.ParameterType;
                // The body records this codebase declares, by the naming it uses for them everywhere.
                // Services, primitives and framework types are resolved from DI or the route, never
                // deserialized, so they need no metadata.
                if (type.Assembly != coreAssembly || !type.Name.EndsWith("Request", StringComparison.Ordinal))
                {
                    continue;
                }

                checkedTypes++;
                if (CoreJsonSerializerContext.Default.GetTypeInfo(type) is null)
                {
                    missing.Add($"{type.Name} ({endpoint.RoutePattern.RawText})");
                }
            }
        }

        // Guards the guard: a harness that stopped exposing handler metadata would make the loop above
        // vacuous and silently pass forever.
        Assert.True(checkedTypes > 0, "No request body types were inspected — the endpoint metadata shape changed.");
        Assert.True(
            missing.Count == 0,
            "Request body types missing a [JsonSerializable] entry in CoreJsonSerializerContext — these throw at " +
            $"route-table build time under Native AOT and take every endpoint down with them: {string.Join(", ", missing)}");
    }
}
