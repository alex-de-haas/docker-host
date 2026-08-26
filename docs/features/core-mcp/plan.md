# Core MCP: The Host's Own Audit

Status: Draft
Created: 2026-08-20
Updated: 2026-08-20

Let an agent answer "what happened to this app", which is the question Core MCP currently cannot
answer about the thing it owns.

## Goal

`tail_app_logs` shows what an app *said*. Nothing shows what was *done to it* — started, stopped,
updated, reconfigured, by whom, and whether it worked. An operator asking "why did this restart" is
asking about actions on the host, and the record of those actions exists: Core has written an audit
log all along.

It became sharper the moment lifecycle mutations landed on this surface. An agent can now stop an app
and cannot read that it did; the record of an agent's own actions is the one thing the agent is
blind to.

## Current Behavior

- `AuditStore` appends one JSON line per action: `Action`, `ResourceType`, `ResourceId`, `Outcome`,
  `ActorUserId`, `CreatedAt`, and a free-form `Details` map.
- Reachable **only** over the CLI's control channel (`GET /control/v1/audit/recent`), so it needs a
  shell on the host. Neither Shell nor any agent client can read it.
- `ReadRecentAsync(limit = 100)` reads the **whole file** with `ReadAllLinesAsync`, reverses it, and
  takes the newest N.
- **Nothing trims the log.** There is no retention sweep for it anywhere.
- Core MCP today: four reads (`list_apps`, `get_app`, `get_host_status`, `tail_app_logs`) and three
  lifecycle mutations behind the `mcp:lifecycle` standing grant, every one of them audited.

## Target Behavior

- One read-only tool, `search_audit`, filtered the way the question is actually asked: by app, by
  action prefix, by outcome, and over a time range.
- **`readOnlyHint: true`**, so it reaches gated clients and the `hosty mcp` connector — which
  refuses to export anything that does not declare it.
- **Every result states the window that produced it** — range, limit, whether either was clamped, and
  whether more exists. This is not a nicety: an agent that cannot see truncation reports "nothing
  happened" when it means "nothing in the newest fifty", which is a false statement about the host
  rather than a report about the query. The telemetry surface pays for this lesson already.
- Refusals are visible. An agent's own stopped app appears in its own audit trail, and so does a
  refusal it received — which is the more interesting half.

## Deliverables

- [ ] `AuditStore` gains a filtered, bounded read: by resource id, action prefix, outcome and time
      range, without loading the whole file for every call.
- [ ] `search_audit` on Core MCP, `readOnlyHint: true`, with the window contract in every result.
- [ ] A stated rule for `Details`, enforced where audit records are written rather than where they
      are read: this tool turns that map into an export surface, and today nothing constrains what a
      future call site puts in it.
- [ ] Retention for the audit log, or an explicit decision that it grows forever with the reason.
- [ ] Tests: the filters as pairs (a match beside a non-match), the window contract in every
      direction, and `Details` asserted to carry no credential material for every existing writer.
- [ ] Docs: `feature.md`, index.

## Open Questions

1. **Does this need its own scope?** Reads today take `mcp:read`. Audit is a different kind of read —
   it says who did what, including actions by other operators — and an admin-only surface arguably
   covers it. The alternative, `mcp:audit`, costs a scope and buys the ability to hand an agent app
   state without handing it the host's history.
2. **How is `Details` constrained?** Every existing writer records metadata (ids, counts, scopes,
   labels) and no secret values — checked, not assumed. But nothing *enforces* that, and this tool is
   what makes a future slip into an export. A redaction list at the read is a lie waiting to go
   stale; a rule at the write needs somewhere to live.
3. **Retention.** The log has grown unbounded since it was written. Trimming it changes what an
   investigation can reach; not trimming makes every read of it slower forever. The MCP tool does not
   create this problem, but it is the first thing that reads the log often enough to feel it.
4. **Should an agent see other actors' actions?** The record includes `ActorUserId`. On an admin-only
   surface every reader could see them anyway through Shell; the question is whether a *tool* that
   surfaces them to a model is the same decision.

## Verification

- Live: stop an app through `stop_app`, then find that action, its actor and its outcome through
  `search_audit` — the agent reading its own trail is the loop this exists to close.
- The negative that matters: a refused mutation appears too. A tool that only recorded successes
  would hide exactly the case an operator investigates.
