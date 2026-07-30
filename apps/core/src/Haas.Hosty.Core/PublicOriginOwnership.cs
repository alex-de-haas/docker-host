namespace Haas.Hosty.Core;

// Who owns HOSTY_PUBLIC_ORIGIN_<endpoint> for a given app endpoint right now. Exactly one surface owns
// it at a time, and which one is decided by the ingress provider:
//
//   none             — the operator. Every public origin is theirs to type, and nothing overwrites it.
//   cloudflared      — the local-config provider. It derives {subdomain}.{baseDomain} for every public
//                      endpoint on every start, so an operator-typed value would be silently replaced.
//   cloudflare-remote— the publication. It owns the endpoints that have one; endpoints with no
//                      publication stay operator-owned, because fronting one endpoint with your own
//                      proxy while publishing another is a legitimate arrangement.
//
// This is the authority for the `configure` guard. Clients render editability from the same rule, but a
// client cannot be trusted with it: the two-surfaces defect existed precisely because Shell's rule and
// Core's behavior disagreed.
internal sealed class PublicOriginOwnership(CoreSettingsService settings, CloudflarePublicationStore publications)
{
    // The subset of `settingKeys` that the active provider owns. Keys that are not public-origin
    // settings are never returned.
    public async Task<IReadOnlyCollection<string>> FindManagedKeysAsync(
        string appId,
        IEnumerable<string>? settingKeys,
        CancellationToken cancellationToken = default)
    {
        var candidates = (settingKeys ?? []).Where(PublicOriginSettings.IsSettingKey).ToArray();
        if (candidates.Length == 0)
        {
            return [];
        }

        var ingress = settings.Ingress;
        if (ingress.DerivesPublicOrigins)
        {
            return candidates;
        }

        if (!ingress.PublishesThroughApi)
        {
            return [];
        }

        // Compare in the setting-key direction: BuildSettingKey normalizes (uppercase, non-alphanumeric
        // to underscore), so an endpoint key cannot be recovered from a setting key, but a publication's
        // endpoint key maps to exactly one setting key.
        var published = (await publications.ListForAppAsync(appId, cancellationToken))
            .Select(publication => PublicOriginSettings.BuildSettingKey(publication.EndpointKey))
            .ToHashSet(StringComparer.Ordinal);
        return candidates.Where(published.Contains).ToArray();
    }
}
