namespace Haas.Hosty.Cli.Mcp;

using System.Security.Cryptography;
using System.Text;

/// <summary>
/// Maps an app's tool onto the name an MCP client will show the model, per the mapping settled in
/// docs/features/hosty-mcp-connector/plan.md.
/// </summary>
/// <remarks>
/// The exported name has to be <b>unique and stable</b> — not decodable. The connector keeps its own
/// table from exported name back to (app, interface, tool), so nothing ever parses these strings; what
/// matters is that two distinct tools never collide, and that a given tool's name does not change when
/// some <i>other</i> app is installed. The second property is why collisions are avoided by
/// construction rather than by disambiguating after the fact: a client's permission rules are written
/// against these names, and a name that shifts under them fails silently.
/// </remarks>
internal static class ToolKey
{
    /// <summary>The interface key that is left out of the name, since nearly every app uses it.</summary>
    public const string DefaultInterfaceKey = "default";

    /// <summary>
    /// Longest key (app + interface) before it is replaced by a truncated form. Core accepts an app id
    /// of up to 63 characters and the escape below can nearly double one, so an unbounded key would
    /// push whole apps past what clients accept — see rule 3 in the plan.
    /// </summary>
    private const int MaxKeyChars = 32;

    /// <summary>Characters kept from the digest when a key is truncated: 32 bits of app-specific hash.</summary>
    private const int DigestChars = 8;

    /// <summary>
    /// Default ceiling on the name this connector exports. A client prepends its own
    /// <c>mcp__&lt;server&gt;__</c>, which is 12 characters for a server entry named <c>hosty</c>, so
    /// this default keeps the string the model finally sees within 64. Packaging that uses longer
    /// server names should lower it.
    /// </summary>
    public const int DefaultMaxToolNameChars = 52;

    /// <summary>
    /// The stable key for one app interface. Pure in its two arguments — nothing about the rest of the
    /// fleet reaches it.
    /// </summary>
    public static string ForInterface(string appId, string? interfaceKey)
    {
        var key = string.IsNullOrWhiteSpace(interfaceKey) ? DefaultInterfaceKey : interfaceKey.Trim();
        var escaped = Escape(appId);
        var composed = string.Equals(key, DefaultInterfaceKey, StringComparison.Ordinal)
            ? escaped
            : $"{escaped}__{key}";

        return composed.Length <= MaxKeyChars ? composed : Truncate(composed, appId, key);
    }

    /// <summary>
    /// The exported tool name, or null when the tool cannot be offered under this mapping.
    /// </summary>
    /// <remarks>
    /// Two refusals, both of which the caller logs rather than swallowing:
    /// <list type="bullet">
    /// <item>a tool whose own name contains <c>__</c>, which would make the boundary between key and
    /// tool ambiguous — this is what stops app <c>X</c>'s tool <c>admin__foo</c> colliding with app
    /// <c>X</c>'s <c>admin</c> interface offering <c>foo</c>;</item>
    /// <item>a name over the ceiling. Refused, never truncated: truncating collides tool names with
    /// each other, which is strictly worse than not offering one.</item>
    /// </list>
    /// </remarks>
    public static string? ForTool(string key, string toolName, int maxToolNameChars = DefaultMaxToolNameChars)
    {
        if (string.IsNullOrWhiteSpace(toolName) || toolName.Contains("__", StringComparison.Ordinal))
        {
            return null;
        }

        var name = $"{key}__{toolName}";
        return name.Length <= maxToolNameChars ? name : null;
    }

    /// <summary>
    /// Escapes an app id into <c>[a-z0-9_-]</c> such that the result can never contain <c>__</c>:
    /// every <c>_</c> it emits is immediately followed by <c>d</c>, <c>u</c>, or <c>x</c>. That is the
    /// property the whole mapping rests on, because it makes the first <c>__</c> in a composed name an
    /// unambiguous boundary.
    /// </summary>
    /// <remarks>
    /// Reversible, which is how it stays injective — the naive alternative of replacing <c>.</c> with
    /// <c>-</c> maps <c>com.example.notes</c> and <c>com-example-notes</c> onto the same string, a bug
    /// already found and fixed once in the AI gateway.
    /// Core's id pattern admits only <c>[a-z0-9._-]</c>, so the <c>_x</c> escape is unreachable through
    /// a validated manifest; it exists so a hand-edited registry cannot produce a colliding key.
    /// </remarks>
    internal static string Escape(string appId)
    {
        var builder = new StringBuilder(appId.Length + 8);
        foreach (var character in appId)
        {
            switch (character)
            {
                case '.':
                    builder.Append("_d");
                    break;
                case '_':
                    builder.Append("_u");
                    break;
                case >= 'a' and <= 'z':
                case >= '0' and <= '9':
                case '-':
                    builder.Append(character);
                    break;
                default:
                    builder.Append("_x").Append(((int)character).ToString("x2"));
                    break;
            }
        }

        return builder.ToString();
    }

    /// <summary>
    /// Replaces an over-long key with a fixed-width form: a readable prefix, then a digest of the
    /// identity it came from. The digest is taken over the <i>unescaped</i> app id and interface key
    /// joined by a space — a character neither may contain — so two different identities cannot feed
    /// the hash the same bytes.
    /// </summary>
    private static string Truncate(string composed, string appId, string interfaceKey)
    {
        var digest = Convert.ToHexStringLower(
            SHA256.HashData(Encoding.UTF8.GetBytes($"{appId} {interfaceKey}")))[..DigestChars];
        return $"{composed[..(MaxKeyChars - DigestChars - 1)]}-{digest}";
    }
}
