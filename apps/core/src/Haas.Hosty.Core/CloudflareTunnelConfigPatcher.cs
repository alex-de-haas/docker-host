using System.Text.Json.Nodes;

namespace Haas.Hosty.Core;

// Cloudflare ingress: the preservation-safe patcher for a remotely managed
// tunnel's ingress rules. Cloudflare exposes only a whole-document PUT, so a mutation must read the latest
// config, change ONLY the Hosty-owned hostname, and re-submit everything else verbatim. This operates on a
// pass-through JsonObject and returns a new document, so unknown/sibling top-level keys (e.g. `warp-routing`,
// confirmed present in the phase-0 spike), other apps' ingress rules, per-rule `originRequest`, relative
// order, and the final catch-all all survive. Ownership/adoption decisions live in the service layer; this
// is purely structural. See docs/features/cloudflare-ingress/feature.md ("Tunnel Configuration
// Mutation").
internal static class CloudflareTunnelConfigPatcher
{
    // Add or update the ingress rule for `hostname` → `service`. An existing rule keeps its other properties
    // (e.g. originRequest) and only its `service` changes; a new rule is inserted immediately before the
    // catch-all. Returns a new document; the input is not mutated.
    public static JsonObject UpsertIngress(JsonObject config, string hostname, string service)
    {
        ArgumentNullException.ThrowIfNull(config);
        ArgumentException.ThrowIfNullOrWhiteSpace(hostname);
        ArgumentException.ThrowIfNullOrWhiteSpace(service);
        var clone = (JsonObject)config.DeepClone();
        var ingress = GetOrCreateIngress(clone);
        var index = FindRuleIndex(ingress, hostname);
        if (index >= 0)
        {
            ((JsonObject)ingress[index]!)["service"] = service;
            return clone;
        }

        var rule = new JsonObject { ["hostname"] = hostname, ["service"] = service };
        var catchAll = CatchAllIndex(ingress);
        if (catchAll < 0)
        {
            // Cast to JsonNode to bind JsonArray's non-generic Add. The generic Add<T> can route a value
            // through JsonValue.Create and is therefore annotated RequiresUnreferencedCode /
            // RequiresDynamicCode, which Core's Native AOT publish reports as IL2026/IL3050. The rule is
            // already a JsonNode, so the append itself is unchanged.
            ingress.Add((JsonNode)rule);
        }
        else
        {
            ingress.Insert(catchAll, rule);
        }

        return clone;
    }

    // Remove the ingress rule for `hostname`, if present. Everything else — including the catch-all — is
    // preserved. Returns a new document; the input is not mutated.
    public static JsonObject RemoveIngress(JsonObject config, string hostname)
    {
        ArgumentNullException.ThrowIfNull(config);
        ArgumentException.ThrowIfNullOrWhiteSpace(hostname);
        var clone = (JsonObject)config.DeepClone();
        var ingress = GetOrCreateIngress(clone);
        var index = FindRuleIndex(ingress, hostname);
        if (index >= 0)
        {
            ingress.RemoveAt(index);
        }

        return clone;
    }

    // Re-insert a previously captured rule verbatim, before the catch-all, unless a rule for its hostname is
    // already there. The publish rollback puts back the rule a rename removed with this: rebuilding it through
    // UpsertIngress would reconstruct it from hostname + service alone and silently drop everything else it
    // carried, `originRequest` included. Returns a new document; neither input is mutated.
    public static JsonObject RestoreIngress(JsonObject config, JsonObject rule)
    {
        ArgumentNullException.ThrowIfNull(config);
        ArgumentNullException.ThrowIfNull(rule);
        var hostname = (string?)rule["hostname"];
        ArgumentException.ThrowIfNullOrWhiteSpace(hostname);
        var clone = (JsonObject)config.DeepClone();
        var ingress = GetOrCreateIngress(clone);
        if (FindRuleIndex(ingress, hostname) >= 0)
        {
            return clone;
        }

        var restored = (JsonObject)rule.DeepClone();
        var catchAll = CatchAllIndex(ingress);
        if (catchAll < 0)
        {
            // Cast to JsonNode for the same AOT reason as UpsertIngress.
            ingress.Add((JsonNode)restored);
        }
        else
        {
            ingress.Insert(catchAll, restored);
        }

        return clone;
    }

    // The rule currently serving `hostname`, or null. Returned as the live node so a caller that wants to keep
    // it across a mutation clones it; the publish path does exactly that before removing a renamed rule.
    public static JsonObject? FindIngress(JsonObject config, string hostname)
    {
        ArgumentNullException.ThrowIfNull(config);
        if (config["ingress"] is not JsonArray ingress)
        {
            return null;
        }

        var index = FindRuleIndex(ingress, hostname);
        return index >= 0 ? (JsonObject)ingress[index]! : null;
    }

    // The exact host targets currently in the ingress array (excludes the hostname-less catch-all). Used by
    // the service layer for ownership/conflict checks without re-parsing.
    public static IReadOnlyList<string> IngressHostnames(JsonObject config)
    {
        if (config["ingress"] is not JsonArray ingress)
        {
            return [];
        }

        return ingress
            .OfType<JsonObject>()
            .Select(rule => (string?)rule["hostname"])
            .OfType<string>()
            .ToArray();
    }

    private static JsonArray GetOrCreateIngress(JsonObject config)
    {
        if (config["ingress"] is JsonArray array)
        {
            return array;
        }

        // A configuration must always keep a final catch-all; synthesize a minimal one if it is somehow
        // missing so the document stays valid after a first insert.
        var created = new JsonArray(new JsonObject { ["service"] = "http_status:404" });
        config["ingress"] = created;
        return created;
    }

    private static int FindRuleIndex(JsonArray ingress, string hostname)
    {
        for (var index = 0; index < ingress.Count; index++)
        {
            // Require an actual hostname so a lookup can never match (and thus overwrite or delete) the
            // hostname-less catch-all rule.
            if (ingress[index] is JsonObject rule &&
                rule["hostname"] is not null &&
                string.Equals((string?)rule["hostname"], hostname, StringComparison.OrdinalIgnoreCase))
            {
                return index;
            }
        }

        return -1;
    }

    // The catch-all is the first rule with no hostname (Cloudflare keeps it last, but we locate it rather
    // than assume the position). New hostnames are inserted before it.
    private static int CatchAllIndex(JsonArray ingress)
    {
        for (var index = 0; index < ingress.Count; index++)
        {
            if (ingress[index] is JsonObject rule && rule["hostname"] is null)
            {
                return index;
            }
        }

        return -1;
    }
}
