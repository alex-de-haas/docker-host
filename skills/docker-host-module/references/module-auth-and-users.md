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

## Shell Apps

- Module browser UIs open through the Host shell using `ui` metadata and `/api/apps`.
- Shell Apps are authenticated Host experiences; there is no anonymous shell App mode.
- Dedicated subdomains are reserved for separate service/API exposures.
- Embedded module UI traffic uses reserved Host routes such as `/api/apps/{moduleId}/embed`.

## Identity Token

When identity propagation is enabled, Docker Host sends a signed JWT in:

```text
X-Docker-Host-Identity: <jwt>
```

Token rules:

- Validate the token signature against Host JWKS from `/.well-known/docker-host/jwks.json`.
- Use Host discovery from `/.well-known/docker-host/module-identity.json` when available.
- Require issuer `docker-host`.
- Require audience equal to the target module id.
- Reject expired tokens.
- Use `sub` as the stable Host user id for module-owned records.
- Treat `hostRole`, `moduleAccess`, `moduleExposurePolicy`, email, and name as claims inside the signed token, not as standalone trusted headers.
- Public anonymous requests normally do not include a user token.

Common claims:

```json
{
  "iss": "docker-host",
  "sub": "user_123",
  "aud": "com.acme.reports",
  "hostRole": "host.user",
  "moduleAccess": "assigned",
  "moduleExposurePolicy": "assignedUsersOnly",
  "email": "work@example.com",
  "name": "Work User",
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
