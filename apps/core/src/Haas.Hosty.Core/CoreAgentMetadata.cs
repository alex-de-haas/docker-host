using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed partial class CoreAgentExecution
{
    private static void Object(JsonElement value, params string[] keys)
    {
        if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Any(p => !keys.Contains(p.Name, StringComparer.Ordinal)))
            throw Invalid("Use only documented authorization metadata fields.");
    }
    private static void Text(JsonElement value, string name, int max = 256)
    {
        if (!value.TryGetProperty(name, out var text) || text.ValueKind != JsonValueKind.String
            || text.GetString() is not { Length: > 0 } s || s.Length > max || s.Any(char.IsControl))
            throw Invalid("Authorization references must be bounded metadata strings.");
    }
    private static void ValidateResources(JsonElement resources)
    {
        if (resources.ValueKind != JsonValueKind.Array || resources.GetArrayLength() > 100) throw Invalid("Use at most 100 resource references.");
        foreach (var resource in resources.EnumerateArray())
        {
            Object(resource, "kind", "id", "revision", "provider");
            Text(resource, "kind", 64); Text(resource, "id"); Text(resource, "revision");
            if (resource.TryGetProperty("provider", out var provider) && provider.ValueKind != JsonValueKind.Null) { Object(provider, "appId", "installationId", "key"); Text(provider, "appId"); Text(provider, "installationId"); Text(provider, "key"); }
        }
    }
    private static void ValidateMcpPolicy(JsonElement policy)
    {
        Object(policy, "default", "autoAllowReadOnly", "tools"); Text(policy, "default", 10);
        if (policy.GetProperty("default").GetString() is not ("ask" or "run")) throw Invalid("Use ask or run as the MCP default policy.");
        if (policy.TryGetProperty("autoAllowReadOnly", out var readOnly) && readOnly.ValueKind is not (JsonValueKind.Null or JsonValueKind.True or JsonValueKind.False))
            throw Invalid("The read-only auto-allow policy is boolean.");
        if (!policy.TryGetProperty("tools", out var tools) || tools.ValueKind == JsonValueKind.Null) return;
        if (tools.ValueKind != JsonValueKind.Object || tools.EnumerateObject().Count() > 512) throw Invalid("Supply at most 512 tool policies.");
        foreach (var rule in tools.EnumerateObject())
        {
            if (rule.Name.Length is 0 or > 256 || rule.Name.Any(char.IsControl)) throw Invalid("Use bounded tool names.");
            Object(rule.Value, "mode", "definition"); Text(rule.Value, "mode", 10);
            var mode = rule.Value.GetProperty("mode").GetString();
            if (mode is not ("ask" or "run" or "disabled")) throw Invalid("Use ask, run or disabled for a tool policy.");
            if (mode == "run")
            {
                Text(rule.Value, "definition", 64);
                if (!System.Text.RegularExpressions.Regex.IsMatch(rule.Value.GetProperty("definition").GetString()!, "^[a-f0-9]{64}$")) throw Invalid("Automatic tool rules require a definition digest.");
            }
            else if (rule.Value.TryGetProperty("definition", out var definition) && definition.ValueKind != JsonValueKind.Null)
                throw Invalid("Only automatic tool rules carry a definition digest.");
        }
    }
    private static void ValidateCeiling(JsonElement ceiling)
    {
        Object(ceiling, "mcp", "resources", "deadline", "configurationRevision", "workflow");
        if (ceiling.TryGetProperty("workflow", out var workflow) && workflow.ValueKind != JsonValueKind.Null)
        {
            Object(workflow, "executor", "sessionId", "tools", "policy"); Text(workflow, "sessionId", 200);
            if (workflow.TryGetProperty("tools", out var selectedTools) && selectedTools.ValueKind != JsonValueKind.Null
                && (selectedTools.ValueKind != JsonValueKind.Array || selectedTools.GetArrayLength() > CoreProviderMediation.AllWorkflowTools.Count
                    || selectedTools.EnumerateArray().Any(t => t.ValueKind != JsonValueKind.String
                        || !CoreProviderMediation.AllWorkflowTools.Contains(t.GetString()!))))
                throw Invalid("Select only the bounded session workflow tool names.");
            if (workflow.TryGetProperty("policy", out var workflowPolicy) && workflowPolicy.ValueKind != JsonValueKind.Null)
            {
                ValidateMcpPolicy(workflowPolicy);
                if (workflowPolicy.TryGetProperty("tools", out var rules) && rules.ValueKind == JsonValueKind.Object
                    && rules.EnumerateObject().Any(t => !CoreProviderMediation.AllWorkflowTools.Contains(t.Name)))
                    throw Invalid("Session workflow policy applies only to declared tools.");
            }
            if (!workflow.TryGetProperty("executor", out var executor)) throw Invalid("A workflow executor reference is required.");
            Object(executor, "appId", "installationId", "key");
            Text(executor, "appId"); Text(executor, "installationId"); Text(executor, "key");
            if (!Guid.TryParse(workflow.GetProperty("sessionId").GetString(), out _)) throw Invalid("Use a session workflow UUID.");
        }
        if (ceiling.TryGetProperty("resources", out var resources) && resources.ValueKind != JsonValueKind.Null) ValidateResources(resources);
        if (ceiling.TryGetProperty("deadline", out var deadline) && deadline.ValueKind != JsonValueKind.Null) Text(ceiling, "deadline", 64);
        if (ceiling.TryGetProperty("configurationRevision", out var revision) && revision.ValueKind != JsonValueKind.Null) Text(ceiling, "configurationRevision");
        if (!ceiling.TryGetProperty("mcp", out var mcp) || mcp.ValueKind == JsonValueKind.Null) return;
        Object(mcp, "targets", "connections");
        if (mcp.TryGetProperty("connections", out var connections) && connections.ValueKind != JsonValueKind.Null)
        {
            if (connections.ValueKind != JsonValueKind.Array || connections.GetArrayLength() > 100) throw Invalid("Select at most 100 external MCP connections.");
            foreach (var connection in connections.EnumerateArray()) { Object(connection, "id", "revision"); Text(connection, "id"); Text(connection, "revision"); }
        }
        if (!mcp.TryGetProperty("targets", out var targets) || targets.ValueKind == JsonValueKind.Null) return;
        if (targets.ValueKind != JsonValueKind.Array || targets.GetArrayLength() > 100) throw Invalid("Select at most 100 Core-managed MCP targets.");
        foreach (var entry in targets.EnumerateArray())
        {
            Object(entry, "target", "tools", "policy");
            if (entry.TryGetProperty("policy", out var policy) && policy.ValueKind != JsonValueKind.Null) ValidateMcpPolicy(policy);
            if (!entry.TryGetProperty("target", out var target)) throw Invalid("An MCP target is required.");
            Object(target, "kind", "appId", "installationId", "key"); Text(target, "kind", 10);
            var kind = target.GetProperty("kind").GetString();
            if (kind == "app") { Text(target, "appId"); Text(target, "installationId"); Text(target, "key"); }
            else if (kind != "core") throw Invalid("Select a Core or app MCP target.");
            if (entry.TryGetProperty("tools", out var tools) && tools.ValueKind != JsonValueKind.Null && (tools.ValueKind != JsonValueKind.Array || tools.GetArrayLength() > 1000
                || tools.EnumerateArray().Any(t => t.ValueKind != JsonValueKind.String || t.GetString() is not { Length: > 0 and <= 256 } name || name.Any(char.IsControl))))
                throw Invalid("Supply a bounded MCP tool selection.");
        }
    }
}
