using System.Text.Json;
using Haas.Hosty.Releases;

namespace Haas.Hosty.Core;

internal sealed partial class DockerRuntimeAdapter : IImageReadinessResolver
{
    public async Task<ImageReadiness> CheckImageAsync(RuntimeDockerImage image, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(20));
        string? platform = null;
        try
        {
            var daemon = await runner.RunBoundedAsync(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"], 4096, deadline.Token);
            platform = daemon.StandardOutput.Trim();
            if (daemon.ExitCode != 0 || platform.Split('/') is not [var os, var arch]
                || string.IsNullOrWhiteSpace(os) || string.IsNullOrWhiteSpace(arch))
                return new(null, "docker_platform_unavailable", "The Docker daemon's target platform could not be determined.");
            ImageReadiness? result = null;
            if (registryDigestResolver is IRegistryImageReadiness registry)
            {
                result = await registry.CheckAsync(image, platform, deadline.Token);
                if (result.Ready || result.ErrorCode is "image_digest_mismatch" or "image_manifest_invalid" or "image_platform_unavailable"
                    or "image_blob_invalid" or "image_manifest_too_large" or "registry_rate_limited") return result;
            }
            // Private registry credentials remain inside Docker. An exact pull verifies the entire
            // graph, including layer bytes; manifest inspection alone cannot prove blob availability.
            var digest = image.Digest ?? await ResolveRemoteDigestAsync(image, deadline.Token);
            if (!ArtifactIdentity.IsDigest(digest)) return result ?? new(null, "image_revision_unavailable", "The image revision could not be resolved.", platform);
            var exact = (image with { Digest = digest }).Reference;
            var pull = await runner.RunBoundedAsync(["pull", "--platform", platform, exact], 65536, deadline.Token);
            if (pull.ExitCode != 0) return new(null, ClassifyImageFailure(pull.StandardError), "Docker could not verify all required image content.", platform);
            var inspect = await runner.RunBoundedAsync(["image", "inspect", "--format", "{{json .}}", exact], 4 * 1024 * 1024, deadline.Token);
            if (inspect.ExitCode != 0) return new(null, "image_manifest_invalid", "The pulled image could not be inspected.", platform);
            using var json = JsonDocument.Parse(inspect.StandardOutput);
            var installed = json.RootElement;
            if (RegistryDigestResolver.ReadString(installed, "Os") + "/" + RegistryDigestResolver.ReadString(installed, "Architecture") != platform)
                return new(null, "image_platform_unavailable", "The pulled image does not target this Docker platform.", platform);
            if (!installed.TryGetProperty("RepoDigests", out var references) || references.ValueKind != JsonValueKind.Array
                || !references.EnumerateArray().Any(value => value.ValueKind == JsonValueKind.String && value.GetString()!.EndsWith("@" + digest, StringComparison.Ordinal)))
                return new(null, "image_digest_mismatch", "Docker did not retain the requested image identity.", platform);
            return new(digest, Platform: platform);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return new(null, "registry_timeout", "Image verification timed out.", platform); }
        catch (JsonException) { return new(null, "image_manifest_invalid", "Docker returned malformed image metadata.", platform); }
        catch (PlatformReleaseException error) { return new(null, error.Code, error.Message, platform); }
        catch (Exception error) when (error is IOException or InvalidOperationException or DockerUnavailableException)
        { return new(null, "registry_unavailable", "The selected image could not be verified.", platform); }
    }
    private static string ClassifyImageFailure(string error)
        => error.Contains("unauthorized", StringComparison.OrdinalIgnoreCase) || error.Contains("denied", StringComparison.OrdinalIgnoreCase) ? "registry_access_denied"
            : error.Contains("manifest unknown", StringComparison.OrdinalIgnoreCase) || error.Contains("not found", StringComparison.OrdinalIgnoreCase) ? "image_missing"
            : error.Contains("429", StringComparison.Ordinal) || error.Contains("toomanyrequests", StringComparison.OrdinalIgnoreCase) ? "registry_rate_limited"
            : "registry_unavailable";
}
