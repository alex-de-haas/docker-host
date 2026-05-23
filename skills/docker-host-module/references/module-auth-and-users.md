# Module Auth And Users Reference

Use this reference when implementing gateway access, Host identity, scoped user directory integration, or module-owned roles.

## Contents

- Boundaries
- Host Roles
- Gateway Policies
- Shell Apps
- Identity Token
- Scoped Module User Directory
- Module-Owned Roles
- External Providers
- External Ingress Readiness

## Boundaries

- Docker Host owns Host login, Host roles, Host sessions, module access assignment, gateway exposure policy, and audit events.
- A module owns its internal domain permissions, such as `reports.admin` or `reports.viewer`.
- Host authorization answers: can this Host user reach this module?
- Module authorization answers: what can this user do inside the module?
- Do not forward Host session cookies to modules.
- Do not trust client-supplied `X-Docker-Host-*`, `Forwarded`, `X-Forwarded-*`, or trusted-proxy assertion headers.

## Host Roles

- `host.admin`: can manage Host configuration, users, modules, gateway exposure, recovery, and security settings.
- `host.user`: can use the authenticated Apps portal and access modules allowed by policy and assignment state.
- A module may choose to map `host.admin` to module administrator behavior, but that mapping belongs to module code.

## Gateway Policies

Gateway exposure policies apply to separate service/API subdomains, not to shell Apps:

- `public`: no login required, no Host assignment required.
- `loginRequired`: any authenticated Host user can reach the endpoint.
- `assignedUsersOnly`: selected Host users can reach the endpoint; `host.admin` can pass for bootstrap and configuration.

The metadata field `endpoints[].public` is only an endpoint capability hint. It does not select a policy.

Gateway exposures also have an `identityMode`:

- `none`: do not send module identity.
- `optional`: send identity only for authenticated requests.
- `required`: require an authenticated principal and send identity.

Default behavior:

- `public` exposures default to `identityMode: "none"` and may opt into `optional`.
- `loginRequired` and `assignedUsersOnly` exposures default to `identityMode: "required"`.

## Shell Apps

- Module browser UIs open through the Host shell using `ui` metadata and `/api/apps`.
- Shell Apps are authenticated Host experiences; there is no anonymous shell App mode.
- Dedicated subdomains are reserved for separate service/API exposures.
- Embedded module UI traffic uses reserved Host routes such as `/api/apps/{moduleId}/embed`.
- The iframe sandbox intentionally does not grant same-origin privileges to module scripts.

## Identity Token

When identity propagation is enabled, Docker Host sends a signed JWT in:

```text
X-Docker-Host-Identity: <jwt>
```

Token rules:

- Tokens are signed with Host-owned ES256 keys.
- Validate the token signature against Host JWKS from `/.well-known/docker-host/jwks.json`.
- Use Host discovery from `/.well-known/docker-host/module-identity.json` when available.
- Require issuer `docker-host`.
- Require audience equal to the target module id.
- Reject expired tokens.
- Expect short-lived tokens, currently 5 minutes.
- Use `sub` as the stable Host user id for module-owned records.
- Treat `hostRole`, `moduleAccess`, `moduleExposurePolicy`, email, and name as claims inside the signed token, not as standalone trusted headers.
- Public anonymous requests normally do not include a user token.
- Public authenticated requests with optional identity use `moduleAccess: "publicAuthenticated"`.
- Installed app embeds use the installed module id as `aud`; developer app embeds preserve the developer target module id as `aud`.

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

## Scoped Module User Directory

Use the scoped directory API when a module needs to assign internal permissions to Host users:

```text
GET /api/internal/modules/{moduleId}/directory/users
```

Module containers receive:

```text
DOCKER_HOST_INTERNAL_ORIGIN
DOCKER_HOST_MODULE_ID
DOCKER_HOST_MODULE_SERVICE_TOKEN
```

Rules:

- Authenticate directory requests with the module service credential, not with a browser user token.
- The directory is scoped to users assigned to that module.
- Directory scope is explicit assignment, even for `loginRequired` modules.
- `host.admin` users appear only when explicitly assigned.
- Store module-owned roles against stable Host user ids from token `sub` or directory `users[].id`.
- Disabled Host users are hidden from normal directory responses.
- Email may be omitted unless the module directory policy opts into exposing it.
- Cache directory responses briefly at most; Host remains authoritative for assignment changes.

## Module-Owned Roles

Recommended model:

- Keep module roles in module-owned storage, for example a JSON file or module database table.
- Use Host user ids as principal keys.
- Provide module UI/API to map assigned Host users to module-specific roles.
- Recompute effective permission from Host identity claims plus module role records per request.
- Avoid embedding Host access policy names directly into domain permissions except for explicit bootstrap behavior.

## External Providers

Docker Host may authenticate users through local auth, generic OIDC, or trusted proxy mode. Modules should not care which provider authenticated the user:

- External providers map into Host users and Host roles before traffic reaches modules.
- Modules still receive only the normal Host-signed `X-Docker-Host-Identity` token.
- Provider-specific headers, OIDC tokens, trusted-proxy assertions, Host cookies, and CLI bearer tokens must not become module identity.
- Account switching changes which Host user signs the module request; modules continue to key records by Host user id.

## External Ingress Readiness

External ingress readiness is Host-owned operational state for service/API exposure publishing. It is not module metadata and it does not create DNS, TLS, tunnels, reverse proxies, or provider-specific Access apps.

When helping publish a module endpoint:

- Keep browser UI in the Host shell unless the module intentionally exposes a separate service/API origin.
- Use gateway exposure policy and identity mode for access control; do not use `endpoints[].public` as a policy.
- Expect readiness records to track manual DNS/proxy/TLS checklist status, drift, and Host-side prerequisites such as `HOST_PUBLIC_ORIGIN` and `HOST_GATEWAY_BASE_DOMAIN`.
