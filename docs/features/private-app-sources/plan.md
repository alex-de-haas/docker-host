# Private App Sources

Status: Draft
Created: 2026-09-28
Updated: 2026-09-28

## Goal

Use [personal provider connections](../user-profile-connections/feature.md) for private installation
sources and updates. The owner approved this direction and sequence on 2026-09-28; this feature
still needs its detailed resource/credential contract before Ready.

## Deliverables

- [ ] Resolve private manifests and Git sources using an explicit owner/connection binding per resource.
- [ ] Review durable read grants for installation and background updates; logout does not revoke the
  grant, while connection removal or user revocation blocks new reads without stopping installed apps.
- [ ] Bind reviewed content and credentials through prepare/confirm/update and recover partial failures.
- [ ] Keep runtime use separate from private source access; other app users do not inherit credentials.
- [ ] Define authenticated feed, release asset and container registry access independently from Git.
- [ ] Add source selection UI, missing-access/reconnect states and multi-account provider integration tests.

## Open Questions

- Which private distribution resources ship first, and how are redirects, API-host mappings and
  third-party artifact hosts authenticated without forwarding credentials to unrelated destinations?
- What explicit read grant survives its initiating browser session, and how do ownership transfer,
  disconnect, user deletion and installed-app lifecycle affect it?
- What registry credential adapters and container-runtime ownership are supported?

## Verification

Install and update apps from two organizations with distinct connections; deny cross-user/source
reuse, detect revoked access, and preserve the running installation after failed updates.
