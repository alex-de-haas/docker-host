# Cross-App Dependencies — Provider Endpoints Off The Host And LAN

Status: Draft
Created: 2026-07-28
Updated: 2026-07-28

## Goal

Let a consumer reach a provider's endpoint without that endpoint being reachable from the host or the
LAN. Today the two requirements are the same knob, which is the one real cost of the current
connectivity design.

## Target behavior

A diff against [feature.md](feature.md)'s `## Discovery (URL injection)`:

- A wired dependency endpoint no longer has to declare `expose: "host"`. A loopback-only endpoint
  becomes reachable by its declared consumers and by nothing else.
- The injected `HOSTY_DEPENDENCY_{ALIAS}_URL` resolves over that path rather than through
  `host.docker.internal:{hostPort}`.
- Non-docker (`localCommand`) consumers keep working — whatever the mechanism, it cannot assume both
  ends are containers.

## Why this is not built

`host.docker.internal` was chosen deliberately, not by omission: it is lifecycle-decoupled, fully
unit-testable, and cannot break app startup. A shared cross-app docker network couples two apps'
lifecycles — network create/remove ordering, a provider restart while a consumer holds an attachment,
cleanup when either is uninstalled — and every one of those failure modes lands on a start path that
currently cannot fail for network reasons.

The exposure it buys back is bounded by the threat model in `feature.md`: a single-tenant homelab
where all installed apps are trusted and there is no app-to-app authentication. So this is a
defence-in-depth improvement, not a hole being closed — worth doing carefully, not urgently.

## Open questions

1. Per-app network (one per provider, consumers attached on demand) or one shared Hosty network? The
   first keeps the blast radius small but multiplies lifecycle bookkeeping.
2. What happens on a provider restart while a consumer is attached — does the consumer's injected URL
   survive, and does anything need to re-resolve?
3. How does a `localCommand` consumer reach a container-network-only endpoint at all? If it cannot,
   does the manifest need to say which consumers a provider expects?
4. Does removing the `expose: "host"` requirement change the endpoint availability vocabulary
   (`assigned` / `running` / `unavailable`) the Shell already renders?
5. Is this subsumed by, or in conflict with, the cross-app authentication sketch in
   [cross-app-auth](../../ideas/cross-app-auth.md)? That document argued for identity over network
   boundaries; the two answers should not be designed independently.

## Deliverables

- [ ] Answer open questions 1–3; without them there is no design to review.
- [ ] Network lifecycle owned by Core (create, attach, detach, remove) with the ordering guarantees a
      start path can rely on.
- [ ] URL resolution and injection updated for the new path, both runtimes.
- [ ] Uninstall/runtime-switch cleanup, so a removed app leaves no networks behind.
- [ ] `feature.md` connectivity caveat rewritten to describe what actually ships.

## Verification

- Unit: a loopback-only provider endpoint resolves to a consumer-reachable URL; a provider restart
  leaves the consumer's wiring intact; removing either app cleans up.
- Live: a `torrent-engine` control endpoint unreachable from the host browser, while `media-server`
  drives it successfully.
