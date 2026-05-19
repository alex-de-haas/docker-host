# Module developer mode

Module developer mode lets module authors test a local dev server through the Docker Host gateway without running the full install flow for every code change.

It is explicitly local-only operational state. It does not change module metadata, installed module records, or production gateway exposure records.

## Modes

Standalone mode remains owned by the module:

```text
module dev server -> http://localhost:3001
auth -> module-owned mock user or local test token
```

Integrated mode is owned by Docker Host:

```text
reports.example.test -> Docker Host Gateway -> http://127.0.0.1:3001
auth -> real Host principal and module-scoped JWT
```

Integrated mode is intended for testing gateway behavior that standalone mode cannot prove: exposure policy, Host sessions, trusted proxy principals, module-scoped identity tokens, header stripping, redirects, WebSockets, SSE, and Host-owned access assignment.

## Decisions

| Topic | Options considered | Decision |
| --- | --- | --- |
| Storage | module metadata, production gateway exposure, or local-only state | Store developer targets in `/data/dev/module-targets.json`. |
| Activation | always enabled, API toggle, or launch setting | Require `HOST_MODULE_DEV_MODE=enabled`. Default is `disabled`. |
| Module requirement | installed module only, ephemeral metadata registration, or raw module id | Use ephemeral metadata registration. Host validates metadata but does not create containers or storage mappings. |
| Target URL | port only, host and port, or absolute URL | Use an absolute HTTP URL, optionally with a path prefix. |
| Target safety | unrestricted, loopback only, or local/private networks | Allow `localhost`, `*.localhost`, `host.docker.internal`, loopback, and private IP ranges. Reject public target URLs. |
| Gateway behavior | separate dev gateway, path routing, or override in existing gateway | Reuse the existing subdomain gateway and override the upstream target only while developer mode is enabled. |
| Identity | mock headers, Host-signed token, or no identity | Integrated mode uses the normal Host-signed `X-Docker-Host-Identity` token. Standalone mocks remain module-owned. |
| Dependencies | all mocked, all installed, or per-dependency overrides | MVP supports a root module developer target. Per-dependency overrides can be added to the same local-only state later. |
| UI | full UI, minimal diagnostics, or CLI/API first | Use CLI/API first. A richer UI can be added when module author workflows are clearer. |

## API

Developer targets are Host admin operations:

| Route | Method | Behavior |
| --- | --- | --- |
| `/api/modules/dev/targets` | `GET` | List developer targets and whether developer mode is active. |
| `/api/modules/dev/targets` | `POST` | Create a developer target from metadata URL, hostname, port key, and target URL. |
| `/api/modules/dev/targets/{targetId}` | `PUT` | Replace a developer target. |
| `/api/modules/dev/targets/{targetId}` | `DELETE` | Remove a developer target. |

Create/update input:

```json
{
  "metadataUrl": "http://localhost:3000/fixtures/modules/sample-reports",
  "hostname": "reports.example.test",
  "portKey": "web",
  "targetBaseUrl": "http://127.0.0.1:3001",
  "exposurePolicy": "loginRequired",
  "identityMode": "required",
  "enabled": true
}
```

The Host downloads and validates the metadata graph, resolves the root module id, checks that `portKey` exists and is marked `public: true`, and stores the normalized target.

## CLI

Enable developer mode:

```bash
docker-host config set HOST_MODULE_DEV_MODE enabled
docker-host restart
```

Manage targets:

```bash
docker-host modules dev list
docker-host modules dev link <metadata-url> <hostname> <port-key> <target-url>
docker-host modules dev unlink <target-id>
```

`modules dev link` also accepts:

```text
--policy public|loginRequired|assignedUsersOnly
--identity none|optional|required
--disabled
```

## Gateway Rules

When developer mode is enabled, the custom gateway checks `/data/dev/module-targets.json` before production gateway exposures. If a hostname matches an enabled developer target:

- Host applies the target's exposure policy;
- Host authenticates through CLI token, trusted proxy assertion, or browser session using the existing rules;
- Host mints the normal module identity JWT when identity mode requires or allows it;
- Host strips Host-owned and trusted proxy headers before forwarding;
- Host proxies HTTP and WebSocket traffic to the local target URL;
- Host preserves the external module hostname in `Host` and `X-Forwarded-Host`.

When developer mode is disabled, stored targets are inert.

## Security Boundaries

- Developer mode is disabled by default.
- Mutating developer target APIs require `host.admin`.
- Target URLs must use `http` and point to localhost, `host.docker.internal`, loopback, or private IP ranges.
- Public target URLs are rejected.
- Developer targets are local state and should not be exported as module metadata or production gateway exposure records.
