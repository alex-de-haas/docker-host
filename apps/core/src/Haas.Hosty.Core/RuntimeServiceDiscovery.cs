using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Haas.Hosty.Core;

// Intra-app service-to-service discovery. When a service `dependsOn` a sibling, Core
// additionally injects the sibling's INTERNAL base URL into the dependent service as
// HOSTY_SERVICE_{KEY}_URL. This is deliberately distinct from the cross-app
// HOSTY_DEPENDENCY_{KEY}_URL namespace (which resolves a *different* installed app's public
// endpoint): the two concerns never collide. The `dependsOn` ordering guarantee is unchanged
// — URL injection is purely additive. The reachable URL differs by runtime: under `docker`
// the sibling is reached by service-name DNS on a per-app user network at its container port;
// under `localCommand` it is reached on the loopback host at its assigned host port.
internal static class RuntimeServiceDiscovery
{
    public const string EnvironmentPrefix = "HOSTY_SERVICE_";

    public static string EnvironmentName(string serviceKey)
        => $"{EnvironmentPrefix}{RuntimePortHelper.NormalizeEnvironmentKey(serviceKey)}_URL";

    // The stable identifier of a port: its explicit `key`, else its container port number.
    public static string PortKey(RuntimePortManifest port)
        => port.Key ?? port.ContainerPort?.ToString(CultureInfo.InvariantCulture) ?? string.Empty;

    public static string Scheme(RuntimePortManifest port)
        => string.IsNullOrWhiteSpace(port.Protocol) ? "http" : port.Protocol;

    // Whether `name` identifies this port — by its stable key or its numeric container port,
    // so a dependency can target `{ "port": "internal" }` or `{ "port": 3000 }` equivalently.
    public static bool PortMatches(RuntimePortManifest port, string name)
        => string.Equals(PortKey(port), name, StringComparison.Ordinal) ||
            string.Equals(port.ContainerPort?.ToString(CultureInfo.InvariantCulture), name, StringComparison.Ordinal);

    // The sibling port a dependent should target: the explicitly named port when given,
    // otherwise the first non-public ("internal") port, falling back to the first declared
    // port. Returns null when the sibling declares no addressable port — an ordering-only
    // dependency that yields no discovery URL.
    public static RuntimePortManifest? ChooseInternalPort(RuntimeSelectedService service, string? namedPort)
    {
        var ports = service.Runtime.Ports.Where(port => port.ContainerPort is not null).ToList();
        if (ports.Count == 0)
        {
            return null;
        }

        if (!string.IsNullOrWhiteSpace(namedPort))
        {
            return ports.FirstOrDefault(port => PortMatches(port, namedPort));
        }

        return ports.FirstOrDefault(port => port.Public != true) ?? ports[0];
    }

    // Builds the HOSTY_SERVICE_{KEY}_URL environment for one dependent service. `urlFactory`
    // renders the reachable base URL for a chosen (sibling, port) pair; it differs by runtime,
    // so each adapter supplies its own. A null/empty factory result is skipped (e.g. the port
    // could not be resolved) rather than emitting a malformed URL.
    public static IEnumerable<KeyValuePair<string, string>> BuildEnvironment(
        IReadOnlyList<RuntimeSelectedService> services,
        RuntimeSelectedService dependent,
        Func<RuntimeSelectedService, RuntimePortManifest, string?> urlFactory)
    {
        foreach (var dependency in dependent.DependsOn)
        {
            var target = services.FirstOrDefault(service => string.Equals(service.Key, dependency.Service, StringComparison.Ordinal));
            if (target is null)
            {
                continue;
            }

            var port = ChooseInternalPort(target, dependency.Port);
            if (port is null)
            {
                continue;
            }

            var url = urlFactory(target, port);
            if (string.IsNullOrEmpty(url))
            {
                continue;
            }

            yield return new KeyValuePair<string, string>(EnvironmentName(dependency.Service), url);
        }
    }
}

// Accepts a `dependsOn` entry as either a bare service-key string or a { service, port }
// object, so the richer port form is purely additive and existing string manifests keep
// parsing. Hand-written (no reflection) so it stays Native-AOT safe under the source generator.
internal sealed class RuntimeServiceDependencyJsonConverter : JsonConverter<RuntimeServiceDependency>
{
    public override RuntimeServiceDependency Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.String)
        {
            return new RuntimeServiceDependency(reader.GetString() ?? string.Empty, null);
        }

        if (reader.TokenType != JsonTokenType.StartObject)
        {
            throw new JsonException("services[].dependsOn entries must be a service-key string or a { service, port } object.");
        }

        string? service = null;
        string? port = null;
        while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
        {
            if (reader.TokenType != JsonTokenType.PropertyName)
            {
                continue;
            }

            var property = reader.GetString();
            reader.Read();
            if (string.Equals(property, "service", StringComparison.OrdinalIgnoreCase) && reader.TokenType == JsonTokenType.String)
            {
                service = reader.GetString();
            }
            else if (string.Equals(property, "port", StringComparison.OrdinalIgnoreCase) && reader.TokenType == JsonTokenType.String)
            {
                // A port may be named by its string key...
                port = reader.GetString();
            }
            else if (string.Equals(property, "port", StringComparison.OrdinalIgnoreCase) && reader.TokenType == JsonTokenType.Number)
            {
                // ...or by its numeric container port.
                port = reader.GetInt32().ToString(CultureInfo.InvariantCulture);
            }
            else
            {
                // Unexpected value (object/array/bool/null, or a wrong-typed known field): skip
                // the whole subtree so the reader stays aligned instead of throwing on Get* or
                // mis-reading nested members as sibling properties.
                reader.Skip();
            }
        }

        return new RuntimeServiceDependency(service ?? string.Empty, string.IsNullOrWhiteSpace(port) ? null : port);
    }

    public override void Write(Utf8JsonWriter writer, RuntimeServiceDependency value, JsonSerializerOptions options)
    {
        // Round-trip the compact form: a bare string when no port is named, else the object.
        if (string.IsNullOrEmpty(value.Port))
        {
            writer.WriteStringValue(value.Service);
            return;
        }

        writer.WriteStartObject();
        writer.WriteString("service", value.Service);
        writer.WriteString("port", value.Port);
        writer.WriteEndObject();
    }
}
