// The ingress provider vocabulary, mirroring Core's IngressSettings. Ingress is one exclusive choice:
// both Cloudflare values drive the same kind of tunnel and differ only in who writes the routes, so
// exactly one of them owns an app's public origins at a time.
//
//   none              — the operator owns exposure and types each app's public origin.
//   cloudflare-remote — a remotely managed tunnel driven over Cloudflare's API; origins come from
//                       publishing an endpoint under a label.
//   cloudflared       — a locally managed tunnel whose config Core renders; origins are derived from
//                       the base domain for every running app.
export const INGRESS_PROVIDER_NONE = "none";
export const INGRESS_PROVIDER_CLOUDFLARE_REMOTE = "cloudflare-remote";
export const INGRESS_PROVIDER_CLOUDFLARED = "cloudflared";

// The group name Core tags its ingress settings with. The Ingress tab renders exactly this group and
// the Core tab renders everything else, so the split needs no new field in the settings contract.
export const INGRESS_SETTINGS_GROUP = "Public ingress";

export const INGRESS_PROVIDER_SETTING_KEY = "HOSTY_INGRESS_PROVIDER";

// The settings that only mean something under the local-config provider: a remotely managed tunnel is
// discovered by connecting, and its zone supplies the base domain.
const LOCAL_CONFIG_SETTING_KEYS = new Set([
  "HOSTY_INGRESS_BASE_DOMAIN",
  "HOSTY_INGRESS_TUNNEL_ID",
  "HOSTY_INGRESS_CREDENTIALS_FILE",
]);

export function isIngressSettingVisible(key: string, provider: string) {
  return LOCAL_CONFIG_SETTING_KEYS.has(key) ? provider === INGRESS_PROVIDER_CLOUDFLARED : true;
}

// Whether publishing an endpoint through Cloudflare's API is what owns public origins right now. The
// publish control renders only under this provider — under any other one, publishing would hand
// ownership of HOSTY_PUBLIC_ORIGIN_* to a surface that is not in charge of it, and Core refuses it.
export function publishesThroughCloudflareApi(provider: string | null | undefined) {
  return provider === INGRESS_PROVIDER_CLOUDFLARE_REMOTE;
}

// Whether Core derives every public origin itself from the base domain, which makes the per-app public
// origin field read-only.
export function derivesPublicOrigins(provider: string | null | undefined) {
  return provider === INGRESS_PROVIDER_CLOUDFLARED;
}

// How a provider reads outside the Ingress tab. An unrecognized value is reported verbatim rather than as
// "None": a provider Core knows and Shell does not is a version skew, and calling it "off" would describe
// a host that is in fact exposing apps.
export function ingressProviderLabel(provider: string | null | undefined) {
  switch (provider) {
    case INGRESS_PROVIDER_CLOUDFLARE_REMOTE:
      return "Cloudflare";
    case INGRESS_PROVIDER_CLOUDFLARED:
      return "Cloudflare Tunnel (local config)";
    case INGRESS_PROVIDER_NONE:
    case null:
    case undefined:
    case "":
      return "None";
    default:
      return provider;
  }
}
