# Internal Endpoint Exposure — Keep Machine-Only Routes Off The Published Origin

Status: Draft
Created: 2026-07-24
Updated: 2026-07-24

## Goal

Stop publishing routes that no browser ever calls. Today a Hosty-managed ingress rule is
`hostname` → `service` with no path component ([CloudflareTunnelConfigPatcher](../../../apps/core/src/Haas.Hosty.Core/CloudflareTunnelConfigPatcher.cs)),
so publishing Core publishes **every** route on it, including the app→Core control surface under
`/api/internal/`. Those routes are credential-protected and that is the real boundary; this feature
would add a second layer, not close a hole.

## Is this worth building? (honest assessment)

**The case for.** An endpoint that answers 401 still confirms it exists and still accepts traffic:
any future slip in a credential check becomes internet-reachable rather than LAN-reachable, and the
`/api/internal/` surface is by definition never browser-facing, so excluding it costs no
functionality. The class has already produced one real finding — the docker-stats exposition shipped
unauthenticated for months on the assumption that "internal" implied a network boundary, which
Hosty's own ingress never provided (C-M10 in the
2026-07-10 Core review, since fixed and superseded; see
[the consolidated review](../../reviews/2026-09-06-consolidated-review.md#superseded-reviews)).

**The case against.** Its coverage is structurally capped: managed Cloudflare ingress is only one way
Core becomes reachable. An operator's own reverse proxy, a port forward, `expose:host` bindings and a
LAN are all outside it. So this can never be *the* protection — and a layer that looks like a
boundary but isn't is how the previous mistake happened. There is also a footgun: a silent path
exclusion would break any later legitimate cross-host use of the control surface in a way that is
hard to diagnose from the app side.

**Recommendation.** Worth doing, low priority, and only if it ships with the framing that credentials
remain authoritative — never as a reason to relax an endpoint's own auth. Not worth doing at all if it
would be presented as "internal routes are now private".

## Target behavior

A diff against today's ingress publication:

- Publishing a Core origin emits, before the origin rule, a rule that refuses the machine-only path
  prefixes (Cloudflare ingress rules support `path`; a `http_status:404` service is the standard way
  to express "not here").
- The prefix list is derived from one declared constant, not duplicated per call site, so a new
  internal prefix is covered by construction.
- App origins are unaffected — this is about Core's own published origin.

## Open questions

1. Is a Cloudflare-only mechanism worth having at all given the coverage cap above, or should this
   instead be a documented deployment note for operators who front Core with their own proxy?
2. Should `/control/v1/*` (shared-secret authenticated, CLI-only) be in the same list? It has the
   same "never a browser" property.
3. Does refusing a path interact with how the tunnel's catch-all and other apps' rules are preserved
   by the patcher? The patcher deliberately re-submits siblings verbatim, so rule ORDER matters and
   needs a test.

## Deliverables

- [ ] Decide question 1 (owner call — the answer may be "close this and keep only the doc note").
- [ ] A declared prefix list + ingress rule emission in the Cloudflare publication path.
- [ ] Patcher tests covering rule order and sibling preservation.
- [ ] Feature doc stating explicitly that credentials, not routing, are the boundary.

## Verification

- Unit: the emitted config refuses `/api/internal/...` and preserves unrelated rules and the
  catch-all in order.
- Live: with a published Core origin, `curl https://<core-host>/api/internal/telemetry/metrics`
  returns 404 from the edge while the in-network scrape keeps working.
