namespace Haas.Hosty.Core;

// Artifact preparation must never run setup, containers, hooks, or app-data mutations.
internal interface IImageArtifactPreparation
{
    Task PrepareImagesAsync(RuntimeAppManifestSelection selection, IReadOnlyDictionary<string, ArtifactLock>? reviewed,
        CancellationToken ct);
}

internal sealed partial class DockerRuntimeAdapter : IImageArtifactPreparation
{
    public async Task PrepareImagesAsync(RuntimeAppManifestSelection selection,
        IReadOnlyDictionary<string, ArtifactLock>? reviewed, CancellationToken ct)
    {
        foreach (var service in selection.Services.Where(service => service.Image is not null && service.Runtime.Build is null))
        {
            var locked = reviewed?.GetValueOrDefault(service.Key);
            if (locked is null || !Haas.Hosty.Releases.ArtifactIdentity.IsDigest(locked.ImageDigest))
                throw new AppLifecycleException("image_revision_unavailable", $"Service '{service.Key}' has no reviewed image digest. Refresh the update check.");
            var exact = service.Image! with { Digest = locked.ImageDigest };
            if (service.Image!.Digest is { } authored && authored != locked.ImageDigest)
                throw new AppLifecycleException("image_digest_mismatch", $"Service '{service.Key}' differs from its reviewed manifest digest.");
            _ = await ResolveImageRunReferenceAsync(exact, locked, ct);
        }
    }
}
