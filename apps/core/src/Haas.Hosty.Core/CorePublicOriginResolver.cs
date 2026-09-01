namespace Haas.Hosty.Core;

// Where Core is publicly reachable — the one origin it hands to browsers and to agent clients.
//
// It resolves live rather than from the startup snapshot, because every reader of it is a link or a
// metadata document built per request: the login page's origin meta, setup/invitation links, the OAuth
// issuer and endpoints, the RFC 9728 protected-resource document, and the WWW-Authenticate pointer on an
// MCP 401. A startup snapshot would leave all of them wrong until someone restarted Core, which is the
// opposite of what an operator who just corrected the value expects.
//
// The layering: the persisted Core setting wins, then the HOSTY_CORE_PUBLIC_ORIGIN environment baseline
// captured at startup, then Core's listen URL. Clearing the setting therefore falls back rather than
// blanking the value — the same stance the ingress settings take towards their env vars, and the reason
// `hosty core settings reset HOSTY_CORE_PUBLIC_ORIGIN` is a complete recovery.
//
// What this value never decides is where anything on this host actually listens. Core answers on
// `ListenUrl` whatever this says, the session cookie's Secure flag follows the request scheme rather than
// this origin, and OAuth resource resolution accepts the listen URL alongside it — so an origin naming a
// host that does not answer costs the operator their public links, never their way back in.
//
// It is also NOT what a runtime app dials Core on. That is HOSTY_CORE_ORIGIN, derived from the listen URL
// (rewritten to host.docker.internal for containers), so a wrong value here cannot break app-to-Core
// traffic. Apps still receive this origin as HOSTY_CORE_PUBLIC_ORIGIN for their own browser-facing links,
// injected when the app starts — which is why a change reaches running apps only when they restart.
internal sealed class CorePublicOriginResolver(HostyCoreRuntimeConfig config, CoreSettingsService settings)
{
    // The operator's configured origin, or null when neither the store nor the environment names one.
    public string? Configured => settings.StoredCorePublicOrigin ?? config.CorePublicOrigin;

    // What Core advertises for itself, always a usable origin.
    public string Effective => Configured ?? config.ListenUrl;

    // What clearing the persisted value would fall back to: the environment baseline, else the listen URL.
    public string Baseline => config.CorePublicOrigin ?? config.ListenUrl;

    public CorePublicOriginSettingRow GetRow()
        => new(Effective, Baseline, Overridden: settings.StoredCorePublicOrigin is not null);
}
