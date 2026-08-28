# Core MCP: The Host's Own Audit

Status: In Progress
Created: 2026-08-26
Updated: 2026-08-28

Let an agent answer "what happened to this app", which is the question Core MCP currently cannot
answer about the thing it owns.

## Goal

`tail_app_logs` shows what an app *said*. Nothing shows what was *done to it* — started, stopped,
updated, reconfigured, by whom, and whether it worked. An operator asking "why did this restart" is
asking about actions on the host, and the record of those actions exists: Core has written an audit
log all along.

It became sharper the moment lifecycle mutations landed on this surface — and revealed a second gap
underneath the first. An agent can now stop an app and cannot read that it did. But an *operator*
stopping the same app through Shell or the CLI writes no record at all, so the asymmetry runs the
other way too: today the agent's actions are the only ones the host remembers.

Reading is therefore the smaller half of this. A tool over a record that mostly does not exist would
answer "why did this restart" only when an agent was the one who restarted it.

## Current Behavior

- `AuditStore` appends one JSON line per action: `Action`, `ResourceType`, `ResourceId`, `Outcome`,
  `ActorUserId`, `CreatedAt`, and a free-form `Details` map.
- Reachable **only** over the CLI's control channel (`GET /control/v1/audit/recent`), so it needs a
  shell on the host. Neither Shell nor any agent client can read it — checked, and there is no Shell
  consumer anywhere.
- **Most lifecycle actions are not recorded at all.** `app.lifecycle.*` is written by exactly one
  caller — `McpEndpoints` — while `LifecycleEndpoints`, the path Shell and the CLI use, calls
  `CoreLifecycleService` without touching `AuditStore`. What exists beside it is `app.{action}` with
  outcome `reported`, which is an **app** describing its own work, not Core recording what it did to
  an app.
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

- [ ] **Core records lifecycle actions wherever they originate**, not only on the MCP path:
      `LifecycleEndpoints` (start, stop, restart, update, autostart, runtime switch) writing the same
      `app.lifecycle.*` shape with the acting user. Without this the reader below has almost nothing
      to read, and the surface would quietly imply the host keeps a history it does not keep.
- [x] `AuditStore` gains a filtered, bounded read: by resource id, action prefix, outcome and time
      range, without loading the whole file for every call.
- [x] `search_audit` on Core MCP, `readOnlyHint: true`, with the window contract in every result.
- [ ] A stated rule for `Details`, enforced where audit records are written rather than where they
      are read: this tool turns that map into an export surface, and today nothing constrains what a
      future call site puts in it.
- [ ] Retention for the audit log, or an explicit decision that it grows forever with the reason.
- [ ] Tests: the filters as pairs (a match beside a non-match), the window contract in every
      direction, and `Details` asserted to carry no credential material for every existing writer.
- [ ] Docs: `feature.md`, index.

## Deliverables — updates

- [x] `plan_app_update` / `apply_app_update`, two steps, behind a **new `mcp:update` scope**.
- [ ] `feature.md` describes both, and the audit tool, as current reality.
- [ ] **The settled outcome of an update reaches the audit.** Applying is reported as *accepted*,
      because the work runs detached and the response carries the pre-update runtime state. Nobody
      writes what happened afterwards: `CoreLifecycleService` holds no `AuditStore`, which is the same
      missing wire as the producer deliverable above. Until it lands, `search_audit` can show that an
      update was accepted and never that it failed.

## Decisions

Owner, 2026-08-28: **ship the reader first; fix who writes what afterwards.** Recorded with what it
costs, because the cost is real and belongs in the document rather than in a conversation.

Until the producer work lands, `search_audit` answers well about credentials, users, backups and
notifications — and about **lifecycle only when an agent performed it**. The operator's own start,
stop and update write nothing. The tool says so in its own description rather than letting an empty
result be read as "nothing happened", which is the failure mode this whole surface is careful about.

- **Actor travels with every entry.** An audit without an actor answers "something happened" rather
  than the question anyone asks of an audit. This is a **new disclosure** — nothing in Shell reads
  the log today — and it is admin-only, like the rest of the surface.
- **`mcp:read`, not a new scope.** A scope for a read that every admin credential already implies
  would be ceremony; the surface is admin-gated and the audit is host state like the rest of it.
- **Updates get their own scope, `mcp:update`.** The lifecycle scope's own note says per-verb scopes
  wait for a demonstrated need; this is not another verb. Start, stop and restart act on what is
  installed, while an update changes *what is installed*, and an operator who granted "restart it when
  it wedges" has not thereby granted "change which version runs" — least of all months later, when a
  scope they approved once would have quietly grown a second meaning.
- **Two calls, not one.** Planning names the versions and the changes; applying names the plan it was
  shown. An approval then attaches to a specific plan rather than to "update this app, whatever that
  means by the time it runs" — and Core refuses a digest that no longer describes what it would do.
- **`sourceConfigured` travels with every plan.** An empty change list means two different things —
  nothing new, or nothing Core could check — and without the flag an agent would announce an app is up
  to date on the strength of a question that was never asked.
- **The read is bounded by a scan ceiling**, not only by the time window. Nothing trims this log, so a
  filter matching three entries in a very long file must not read the file.

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
4. **Should an agent see other actors' actions?** The record includes `ActorUserId`, and this is a
   **new disclosure** rather than parity with something an operator can already see: nothing in Shell
   reads the audit log, so today the only way to it is a shell on the host. An earlier draft of this
   question argued from Shell visibility that does not exist, which would have made the decision look
   already-made. It is not.

## Verification

- Live: stop an app through `stop_app`, then find that action, its actor and its outcome through
  `search_audit` — the agent reading its own trail is the loop this exists to close.
- **And the same stop performed from Shell**, found the same way. That is the pair that proves the
  producer work landed: a surface that could only see the agent's own actions would pass the first
  check and still answer the operator's actual question with silence.
- The negative that matters: a refused mutation appears too. A tool that only recorded successes
  would hide exactly the case an operator investigates.
