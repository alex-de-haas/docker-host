# App Auth And Users Reference

Use this reference when implementing Hosty Shell embedding, standalone app auth, gateway access, Hosty identity, scoped user directory integration, or app-owned roles.

## Boundaries

- Hosty Core owns login, setup, recovery, sessions, Hosty roles, app access assignment, gateway exposure policy, and audit events.
- Hosty Shell is only one client of Core APIs. A future web UI, desktop app, or mobile app can also act as a Shell.
- A runtime app owns its internal domain permissions, such as `reports.admin` or `reports.viewer`.
- Hosty authorization answers: can this Hosty user reach this runtime app?
- App authorization answers: what can this user do inside the app?
- Do not forward Hosty session cookies to runtime apps.
- Do not trust client-supplied `X-Docker-Host-*`, `X-Hosty-*`, `Forwarded`, `X-Forwarded-*`, or trusted-proxy assertion headers.

## Hosty Roles

- `host.admin`: can manage Hosty configuration, users, apps, gateway exposure, recovery, and security settings.
- `host.user`: can use authenticated app experiences and access apps allowed by policy and assignment state.
- A runtime app may map `host.admin` to app administrator behavior, but that mapping belongs to app code.

## Access Modes

Hosty currently supports Shell-embedded runtime app access through the app registry and legacy module assignments. Future standalone and gateway-protected modes are planned separately.

Target model:

- Shell embedded: user logs into Hosty Core through Shell, Shell opens the app in an iframe, and the app receives app-scoped Hosty identity where enabled.
- Standalone Hosty-aware app: app owns its own origin cookie, checks or refreshes identity through Hosty Core, and redirects to Core login when needed.
- Gateway protected: browser traffic goes through a Hosty gateway before reaching an app that is not Hosty-aware or needs an outer access gate.

Gateway-protected mode is optional. It is not the default requirement for Hosty-aware apps.

## Gateway Policies

Gateway exposure policies apply to separate service/API subdomains, not to ordinary Shell discovery:

- `public`: no login required, no Hosty assignment required.
- `loginRequired`: any authenticated Hosty user can reach the endpoint.
- `assignedUsersOnly`: selected Hosty users can reach the endpoint; `host.admin` can pass for bootstrap and configuration.

The manifest field `endpoints[].public` is only an endpoint capability hint. It does not select a policy.

Gateway exposures also have an `identityMode`:

- `none`: do not send app identity.
- `optional`: send identity only for authenticated requests.
- `required`: require an authenticated principal and send identity.

Default behavior:

- `public` exposures default to `identityMode: "none"` and may opt into `optional`.
- `loginRequired` and `assignedUsersOnly` exposures default to `identityMode: "required"`.

## Shell Apps

- Browser UIs open through Hosty Shell using manifest `ui` metadata and `/api/apps`.
- Shell apps are authenticated Hosty experiences; there is no anonymous Shell app mode.
- Dedicated subdomains are reserved for separate service/API exposures or future standalone app origins.
- Embedded app UI traffic uses reserved Host routes such as `/api/apps/{appId}/embed`.
- The iframe sandbox intentionally does not grant same-origin privileges to app scripts.
- Hosty Shell itself is a system app and should not be treated as a removable runtime app.

## Identity Token

When identity propagation is enabled, Hosty sends a signed JWT in:

```text
X-Docker-Host-Identity: <jwt>
```

This header name is currently legacy. Treat it as Hosty app identity unless the code has introduced a newer header.

Token rules:

- Tokens are signed with Hosty Core-owned ES256 keys.
- Validate the token signature against JWKS from `/.well-known/docker-host/jwks.json`.
- Use discovery from `/.well-known/docker-host/module-identity.json` when available.
- Require issuer `docker-host` while the implemented compatibility contract still uses that issuer.
- Require audience equal to the target app or legacy module id.
- Reject expired tokens.
- Expect short-lived tokens, currently 5 minutes.
- Use `sub` as the stable Hosty user id for app-owned records.
- Treat `hostRole`, `moduleAccess`, `moduleExposurePolicy`, email, and name as signed claims, not standalone trusted headers.
- Public anonymous requests normally do not include a user token.
- Public authenticated requests with optional identity use `moduleAccess: "publicAuthenticated"`.
- App embeds use the installed app or module id as `aud`, including local command runtime profiles.

Common claims:

```json
{
  "iss": "docker-host",
  "sub": "user_123",
  "aud": "com.acme.reports",
  "exp": 1790000000,
  "iat": 1789999700,
  "jti": "mit_...",
  "hostRole": "host.user",
  "moduleAccess": "assigned",
  "moduleExposurePolicy": "assignedUsersOnly",
  "email": "work@example.com",
  "name": "Work User",
  "gatewayExposureId": "gw_...",
  "hostname": "reports.example.com",
  "endpointKey": "http"
}
```

## Scoped App User Directory

Use the scoped directory API when a runtime app needs to assign internal permissions to Hosty users:

```text
GET /api/internal/modules/{moduleId}/directory/users
```

The route is still named for legacy modules. Runtime apps using the compatibility adapter should treat `{moduleId}` as the app id.

App containers receive:

```text
DOCKER_HOST_INTERNAL_ORIGIN
DOCKER_HOST_MODULE_ID
DOCKER_HOST_MODULE_SERVICE_TOKEN
```

Rules:

- Authenticate directory requests with the app service credential, not with a browser user token.
- The directory is scoped to users assigned to that app.
- Directory scope is explicit assignment, even for `loginRequired` gateway exposures.
- `host.admin` users appear only when explicitly assigned.
- Store app-owned roles against stable Hosty user ids from token `sub` or directory `users[].id`.
- Disabled Hosty users are hidden from normal directory responses.
- Email may be omitted unless the directory policy opts into exposing it.
- Cache directory responses briefly at most; Hosty remains authoritative for assignment changes.

## App-Owned Roles

Recommended model:

- Keep app roles in app-owned storage, for example a JSON file or app database table.
- Use Hosty user ids as principal keys.
- Provide app UI/API to map assigned Hosty users to app-specific roles.
- Recompute effective permission from Hosty identity claims plus app role records per request.
- Avoid embedding Hosty access policy names directly into domain permissions except for explicit bootstrap behavior.

## Third-Party Integrations

Runtime apps can have their own third-party integrations, for example Azure DevOps PATs, OAuth grants, API keys, or service tokens. These are app-owned integration credentials, not Hosty user authentication.

Hosty can help by:

- storing app settings or secrets when the manifest declares them;
- injecting settings into runtime profiles;
- restricting which Hosty users can configure or open the app.

Hosty should not become the authorization layer for every third-party API a runtime app calls.

## External Providers

Hosty may authenticate users through local auth, OIDC, Auth0, trusted proxy mode, or another future system service. Runtime apps should not care which provider authenticated the user:

- External providers map into Hosty users and Hosty roles before traffic reaches apps.
- Apps still receive only the normal Hosty-signed identity token.
- Provider-specific headers, OIDC tokens, trusted-proxy assertions, Hosty cookies, and CLI bearer tokens must not become app identity.
- Account switching changes which Hosty user signs the app request; apps continue to key records by Hosty user id.

## External Ingress Readiness

External ingress readiness is Hosty-owned operational state for service/API exposure publishing. It is not app manifest metadata and it does not create DNS, TLS, tunnels, reverse proxies, or provider-specific Access apps.

When helping publish an app endpoint:

- Keep browser UI in Hosty Shell unless the app intentionally exposes a separate service/API origin or future standalone app origin.
- Use gateway exposure policy and identity mode for access control; do not use `endpoints[].public` as a policy.
- Expect readiness records to track manual DNS/proxy/TLS checklist status, drift, and Hosty-side prerequisites such as `HOST_PUBLIC_ORIGIN` and `HOST_GATEWAY_BASE_DOMAIN`.
