using System.Text.Json;
using System.Text.Json.Nodes;

namespace Haas.Hosty.Core;

internal sealed record AppDevelopmentManifestClassification(string Kind, string[] Changes, string[] AdditionalAccess)
{
    public bool ReviewRequired => AdditionalAccess.Length != 0;
}

internal sealed record AppDevelopmentAccessPlan(string AppId, string DisplayName, DateTimeOffset Installation,
    string SourcePath, string Runtime, string CandidateDigest, string AuthorityStamp, string PlanDigest,
    string UserId, string Via, string[] Changes, string[] RequiredPermissions, string[] OptionalPermissions,
    string[] BaseGrantedPermissions, string[] BaseConfirmedRoles);
internal sealed record AppDevelopmentCandidate(RuntimeAppManifestSelection Selection, string SourcePath,
    string AuthorityStamp, AppDevelopmentManifestClassification Classification, AppDevelopmentAccessPlan Review, AppDevActor Actor)
{
    public bool ReviewRequired => Classification.ReviewRequired;
    public string[] AdditionalAccess => Classification.AdditionalAccess;
    public string[] Changes => Classification.Changes;
}
internal sealed record AppDevelopmentConsent(AppDevelopmentAccessPlan Plan, string[] GrantedPermissions,
    string[] ConfirmedRoles, DateTimeOffset ApprovedAt);

internal static class AppDevelopmentManifest
{
    // Retained for legacy callers whose contract deliberately permits only release-version edits.
    internal static bool HasSameContract(string installedJson, string sourceJson)
    {
        static JsonObject Contract(string json)
        {
            var manifest = JsonNode.Parse(json)!.AsObject();
            manifest.Remove("version");
            return manifest;
        }
        return JsonNode.DeepEquals(Contract(installedJson), Contract(sourceJson));
    }

    private static bool ContainsSource(string root, string path)
        => root == "." || root == path || path.StartsWith(root.TrimEnd('/') + "/", StringComparison.Ordinal);

    internal static AppDevelopmentManifestClassification Classify(RuntimeAppManifestSelection baseline,
        RuntimeAppManifestSelection candidate, IReadOnlyList<string> granted, IReadOnlyList<string> confirmedRoles,
        IReadOnlyList<AppMountBinding>? boundMounts = null, bool system = false)
    {
        if (baseline.Manifest.Id != candidate.Manifest.Id || baseline.Manifest.SchemaVersion != candidate.Manifest.SchemaVersion)
            throw new AppLifecycleException("dev_manifest_identity_changed", "The workspace manifest must retain the installed app identity and supported schema.");
        var additional = new List<string>();
        foreach (var permission in candidate.Manifest.CorePermissions.Except(granted, StringComparer.Ordinal))
            additional.Add($"Core permission: {permission} — {CoreAppPermissions.Describe(permission)}");
        foreach (var role in PlatformCapabilities.RequestedRoles(candidate.Manifest.Provides).Except(confirmedRoles, StringComparer.Ordinal))
            additional.Add($"Provider role: {role} — {PlatformCapabilities.DescribeRole(role)}");
        if (!system && candidate.Manifest.Role == "system") additional.Add("System application access");

        static HashSet<string> RuntimeAccess(RuntimeAppManifestSelection selection)
        {
            var access = new HashSet<string>(StringComparer.Ordinal);
            foreach (var service in selection.Services)
            {
                var runtime = service.Runtime;
                if (runtime.Type == "localCommand") access.Add("Run commands directly on the host");
                if (runtime.IsHostNetwork) access.Add("Use the host network");
                foreach (var capability in runtime.Capabilities) access.Add("Container capability: " + LinuxCapabilities.Normalize(capability));
                foreach (var device in runtime.Devices) access.Add("Host device: " + device);
                if (runtime.SourceMount is { Mode: "rw" } mount) access.Add("Write workspace source: " + mount.Path);
                foreach (var port in runtime.Ports.Where(p => p.Expose == "host" || p.Public == true))
                    access.Add($"Network exposure: {port.Expose ?? "ingress"}:{port.Protocol ?? "http"}:{port.HostPort ?? port.LocalPort ?? port.ContainerPort}:{string.Join(",", port.Transport ?? ["tcp"])}");
            }
            foreach (var endpoint in selection.Manifest.Endpoints.Where(e => e.Public))
                access.Add($"Public endpoint: {endpoint.Key}:{endpoint.Protocol ?? "http"}");
            return access;
        }
        var priorAccess = RuntimeAccess(baseline);
        additional.AddRange(RuntimeAccess(candidate).Except(priorAccess, StringComparer.Ordinal)
            .Where(access => !access.StartsWith("Write workspace source: ", StringComparison.Ordinal) ||
                !baseline.Services.Any(service => service.Runtime.SourceMount is { Mode: "rw" } mount &&
                    ContainsSource(mount.Path, access["Write workspace source: ".Length..]))));
        foreach (var service in candidate.Services)
        {
            var readPath = service.Runtime.SourceMount?.Path;
            if (readPath is not null && !baseline.Services.Any(prior => prior.Runtime.SourceMount is { } mount && ContainsSource(mount.Path, readPath)))
                additional.Add("Read workspace source: " + readPath);
        }
        foreach (var slot in candidate.Manifest.ExternalMounts)
        {
            if (boundMounts?.Any(m => m.Key == slot.Key) != true) continue;
            if (!baseline.Manifest.ExternalMounts.TryGetValue(slot.Key, out var prior) ||
                prior.Mode == "ro" && slot.Value.Mode != "ro")
                additional.Add("Write external host mount: " + slot.Key);
        }

        // Compare unknown JSON against the parsed vocabulary, rather than silently dropping an
        // extension which this Core cannot classify. Approving it is bound to its exact bytes.
        static JsonNode? Unknown(JsonNode? raw, JsonNode? known)
        {
            if (raw is JsonObject obj)
            {
                var result = new JsonObject();
                foreach (var field in obj)
                {
                    if (known is not JsonObject fields || !fields.ContainsKey(field.Key))
                        result[field.Key] = field.Value?.DeepClone();
                    else if (Unknown(field.Value, fields[field.Key]) is { } child)
                        result[field.Key] = child;
                }
                return result.Count == 0 ? null : result;
            }
            if (raw is JsonArray array && known is JsonArray knownArray)
            {
                var result = new JsonArray();
                for (var index = 0; index < array.Count; index++)
                    result.Add(Unknown(array[index], index < knownArray.Count ? knownArray[index] : null));
                return result.All(child => child is null) ? null : result;
            }
            return null;
        }
        static JsonNode? UnknownFields(RuntimeAppManifestSelection selection) => Unknown(JsonNode.Parse(selection.ManifestJson),
            JsonNode.Parse(JsonSerializer.Serialize(selection.Manifest, CoreJsonSerializerContext.Default.RuntimeAppManifest)));
        if (!JsonNode.DeepEquals(UnknownFields(baseline), UnknownFields(candidate)))
            additional.Add("Manifest extension changed; this Core cannot classify its authority");
        var rawBefore = JsonNode.Parse(baseline.ManifestJson)!.AsObject();
        var rawAfter = JsonNode.Parse(candidate.ManifestJson)!.AsObject();
        foreach (var field in new[] { "name", "description", "version", "catalogMetadata", "ui" })
        { rawBefore.Remove(field); rawAfter.Remove(field); }
        var kind = additional.Count > 0 ? "access" : JsonNode.DeepEquals(rawBefore, rawAfter) ? "metadata" : "execution";
        return new(kind, baseline.ManifestDigest == candidate.ManifestDigest ? [] : ["Workspace manifest " + kind + " changes"],
            additional.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray());
    }
}
