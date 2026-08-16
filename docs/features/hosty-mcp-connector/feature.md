# Hosty MCP Connector

Created: 2026-08-15
Updated: 2026-08-16

`hosty mcp` is a stdio MCP server inside the CLI, spawned by an agent client on the operator's own
machine, presenting every app on one Hosty host as a single server. It is step 7 of the
[AI Agent Bridge](../ai-agent-bridge/plan.md) rollout.

It exists because a static client config can follow neither of two moving things. **A fleet**: MCP
clients fix their server list at session start, so per-app entries go stale the moment an app is
installed, removed, or renamed. **A credential**: a delegated token lives five minutes, so a header
pasted into `.mcp.json` is dead almost immediately — which is why [app-mcp](../app-mcp/feature.md)
recorded that cell of step 6 as unreachable. Being a process rather than a file answers both: it
discovers on the fly and holds the credential itself.

## The Actor

`hosty mcp --user <email-or-id>` is required, and there is nothing to default it to. The local
control channel carries host-operator authority but identifies **no user**, while a delegated token
needs a concrete `sub` and role for the receiving app's access check. Defaulting would mean acting as
whichever administrator was found first.

The argument lives in the client's config, so a non-interactive server never has to ask:

```jsonc
{ "mcpServers": { "hosty": { "command": "hosty", "args": ["mcp", "--user", "you@example.com"] } } }
```

`--context` is rejected with a message rather than ignored. A remote host needs a CLI command that
spends a saved login credential and none exists, so silently accepting the flag would let someone
believe they were talking to a remote host.

## Credentials

Core gained `POST /control/v1/apps/{appId}/delegated-token`: a delegated token for a named app on
behalf of a named user, over the control channel.

It is a new *form* of credential on a channel that already carries unconditional host-operator power,
not a new axis of trust — and it is emphatically not a bypass. It runs the **same** access policy the
session path runs (`RequireAccessibleUserAsync`), so a member who may not reach an app cannot obtain
a token for it through the control secret. Every attempt is audited, refusals included, as
`auth.delegated-token.control`; this is a path to a data-plane credential, and a refusal is the more
interesting half of that record.

The connector caches each token until a minute before expiry. Nothing expiring is ever written into a
client config — the cache lives in the connector process and dies with it.

## Discovery

`GET /control/v1/apps` already resolves declared interfaces to callable URLs, so no new discovery
route was needed. The connector keeps the apps that are running and declare an `mcp` interface with a
resolved URL, then asks each one's own `tools/list` in parallel with a per-app timeout.

Each endpoint gets the full MCP lifecycle first — `initialize`, then `notifications/initialized` —
and any `Mcp-Session-Id` it hands back is carried on every later request. This is not ceremony: the
protocol requires it, and an app built on a standard MCP SDK **rejects** a bare `tools/list`. An
earlier cut skipped it and worked, because the only app exercised was demo-app's hand-rolled server,
which does not enforce the lifecycle — so every SDK-based app would have vanished from the catalog
with no symptom beyond being absent. A session the app stops recognising (it restarted) is dropped
and re-established rather than retried forever.

`tools/list` is paginated, so each app's list is **walked to the end**, every page after the first
asking with the `nextCursor` the app handed back. Reading one page left an app's later tools out of
the catalog entirely — absent and uncallable, with no symptom beyond their not being there.

Two guards bound the walk, because they catch different apps. The **per-app timeout is spent across
the whole walk**, not refreshed per page: one that answered every page just inside a per-page ceiling
would otherwise hold the fan-out twenty times as long, and the fan-out is what a client waits on
before it sees any tools at all. The walk is also **capped at 20 pages**, since a cursor that never
ends would otherwise spin against a fast app for the whole budget.

A page that cannot be read **keeps the pages read before it**, which is a decision about what the walk
produces rather than a default. Were it producing a **permission grant**, the answer would invert: a
truncated grant is indistinguishable from a complete one at the point it is consulted, so refusing the
whole answer would be the only safe reading. What it produces is a **catalog** — every tool in it
passed the read-only filter on its own merits, and every call is still checked against it — so a short
catalog costs reach rather than safety. Dropping the app instead would take away tools that work to
punish a page that did not, and would contradict what the fan-out does one level up, where an app that
fails costs the catalog that app and nothing else.

**Visibility is Core's answer, not the CLI's.** The control channel lists the whole fleet regardless
of actor; an app this user may not reach drops out when Core refuses to issue its token. Reimplementing
the access policy in the CLI would have meant two copies, and the CLI's would be the one nobody
notices going stale.

An app that is stopped, times out, refuses the actor, or answers with an unexpected shape is omitted
with a line on stderr — never fatal, and never confused with an empty fleet.

## Tool Names

`<key>__<tool>`, where the key identifies the app and interface. A client prepends its own
`mcp__<server>__`, so a tool arrives as `mcp__hosty__com_dhaas_ddemo-app__list_people`.

The key is built to be **unique and stable**, not decodable — the connector keeps its own table back
to (app, interface, tool), so nothing parses these strings:

1. The app id is escaped reversibly: `.` → `_d`, `_` → `_u`. The result can never contain `__`,
   because every `_` it emits is followed by `d`, `u`, or `x`. That is what makes the first `__` an
   unambiguous boundary — and why the naive `.` → `-` was rejected, since it maps `com.example.notes`
   and `com-example-notes` onto one string.
2. The interface key is appended only when it is not `default`.
3. A key over 32 characters becomes its first 23 plus a digest of its own app id and interface key.
   Core accepts app ids up to 63 characters and the escape nearly doubles one, so without this a
   legal app could have had every tool rejected by a client for length.
4. A tool whose own name contains `__`, or whose full name would exceed the ceiling (52 by default,
   `--max-tool-name`), is not exported. Refused rather than truncated: truncating collides tool names
   with each other.

Hashing on **length** keeps the property that hashing on **collision** would have lost — a key
depends only on its own app, so a tool's name never changes because an unrelated app was installed,
and client permission rules keyed on names keep matching.

Descriptions are prefixed with the app's display name, which the app's own text has no reason to
carry and the model needs when two apps offer similar tools.

## The Read-Only Boundary

External clients stay read-only until token scopes and an audit callback exist. This is **enforced by
the connector**, not delegated to the client: `readOnlyHint` is advisory metadata a hostile or
careless client ignores.

**Fail-closed.** A tool is exported only when it declares `annotations.readOnlyHint: true`. Anything
else — `false`, absent, a string `"true"`, or the hint at the wrong nesting — counts as possibly
mutating. The field is optional, so treating its absence as read-only would make the filter
decorative; the cost is that an app declaring nothing exports nothing, which is the honest reading of
"we do not know what this does".

A filtered tool is **hidden from `tools/list` and refused on call**. Both: hiding gives the model no
affordance it cannot use, and refusing anyway stops a client calling from a list it cached. The
server's `instructions` say the surface is filtered, which is where the explanation belongs — one
sentence rather than tools that exist only to say no.

This is why `apps/demo-app` now declares annotations on both its MCP tools. Without them a
fail-closed connector exports nothing from it, and a reference implementation is copied as-is.

**What this filter is not.** It keeps a tool the app never claimed was safe from reaching a client. It
does not make the claim *true*: the hint is an assertion an app writes about itself, so an app that is
buggy or hostile can label a mutating tool read-only. Nothing downstream should treat "the connector
exported it" as proof the call is harmless — which is exactly the mistake the removed plugin hook
made, and the reason there is no auto-approval anywhere in this feature.

## Following The Fleet

The registry is polled every 30 seconds and `notifications/tools/list_changed` is sent when anything
a client can observe changes, so an app installed or stopped mid-session appears or disappears without
the client restarting. That is the capability a static config cannot have at all.

The comparison covers the whole descriptor, not just the names: an app update that keeps a tool's name
while changing its input schema or its annotations would otherwise leave a connected client submitting
stale arguments, or applying permission metadata the app has since revised.

## Failures

A failed call is a normal result carrying `isError: true` — the protocol's own signal, so the client
knows it failed while the model can still read why and choose something else. A JSON-RPC error would
end the turn instead. Codes: `app_stopped`, `app_unauthorized` (Core refused a token for this actor
and app — an answer, not a transient fault), `app_error` (the app answered and refused).

An unreachable Core keeps the previous tool list rather than reporting an empty fleet: those are
different facts, and conflating them would tell the model every app vanished.

## Implementation Notes

The protocol is hand-rolled over `Utf8JsonWriter` and `JsonDocument` rather than built on the
`ModelContextProtocol` SDK. The CLI publishes as Native AOT with one dependency and no IL2026/IL3050
warnings — verified by publishing, not assumed — and the surface needed is three methods plus one
notification. Tool schemas are arbitrary JSON copied through rather than modelled, which the SDK's
reflection-based registration does not help with.

Diagnostics go to stderr. stdout carries the protocol, and one stray line on it corrupts the stream
while the client's only symptom is a server that "does not work".

## Packaging

`packages/hosty-claude-plugin` bundles the `.mcp.json` and the `hosty-mcp-connector` skill, which
tells a client how to read the tool names, what the read-only boundary means, and what each failure
code implies.

**It ships no `PreToolUse` hook, and the reason is worth keeping.** One was built, auto-allowing
connector tools on the grounds that the server enforces read-only. That is a misreading of the
connector's own filter: what it enforces is that `readOnlyHint` **is present**, not that the tool
behaves accordingly. The hint is an assertion an app makes about itself, so a hook resting on it would
have let any installed app bypass the operator's approval prompt by writing one field into its
manifest. Connector calls go through the client's normal permission flow. Auto-allowing them needs
read-only enforced by something an app cannot assert for itself — a scoped token — which does not
exist yet.

## Testing Expectations

- The mapping, as claims that could be false rather than reasoning: ids that naively sanitize alike
  stay apart; an id containing `_` cannot forge a segment boundary; a tool named `admin__foo` is
  refused **beside** the `admin` interface's `foo` that must still work; the longest id Core accepts
  fits and two such ids differing only past the truncation point stay distinct; a key is unchanged by
  the rest of the fleet; an over-long name is refused, not truncated.
- The fan-out, over a stubbed transport so the cancellation path is production's: one app timing out
  costs the others nothing; an app the actor may not reach is absent **beside** one they can; a tool
  without a read-only hint is dropped while its sibling survives; a wrong-shaped answer is skipped
  rather than read as an empty fleet; the app receives the delegated token and not the caller's;
  pagination is followed with the app's own cursor echoed back, a cursor that never ends is capped, a
  walk of pages each answered slowly is cut by the one budget they share, and a page that cannot be
  read keeps what was read before it.
- The protocol loop: `initialize` announces `listChanged` and says the surface is filtered; schemas
  and annotations pass through unchanged; a call reaches the app under its *own* name; a stopped app
  fails only its own call and the session answers the next request; a tool absent from the catalog is
  refused **beside** one that is present; a notification is never answered; malformed input does not
  end the session; every line on stdout parses as JSON.
- Core: the control route issues a token the app can validate and whose audience is checked
  positively; the control secret is required, with the permitted call asserted beside two refusals;
  the same access policy as the session path, with an admin succeeding where a member is refused; an
  unknown user and an unknown app stay distinguishable; both the issue and the refusal are audited.
- Native AOT publish is clean, since the reason for hand-rolling the protocol is a property that only
  a publish can demonstrate.
- **Driven live on 2026-08-15**, as the published native binary against a running host. Two runs, and
  the first is worth keeping because of what it could not do: against Core 0.80.0 the token path was
  unreachable — that Core predates the control route and answered `404`, confirmed by probing the
  route directly rather than inferred from the connector's own report. It paid for itself anyway. The
  only message was "would not issue a token for this user", which reads as an access problem and sends
  the reader to the user directory; an empty `404` is now reported as a Core too old to have the route,
  with the ambiguous case — a `404` carrying Core's own answer — kept distinct and tested as a pair.
- **Against Core 0.81.0 and demo-app 0.7.2 the whole chain runs**, verified end to end:
  - the control route issued a token, the MCP lifecycle completed against the app, and `tools/list`
    returned both tools **with no credential anywhere in the caller's configuration** — the property
    the feature exists for;
  - names, descriptions and annotations arrived as designed:
    `com_dhaas_ddemo-app__get_my_app_role`, `[Demo App] …`, and `readOnlyHint` passed through
    untouched;
  - `tools/call` reached demo-app, which validated the token, resolved the Hosty identity to its own
    `admin` app role, and returned its real permission list;
  - **the visibility negative, as the pair it has to be:** the same `tools/list` run as a `host.user`
    who is not assigned to demo-app returned nothing, beside the administrator who saw both tools. The
    connector applies no policy of its own here — Core refuses the token and the app drops out.
  - the run immediately before demo-app was updated is the fail-closed rule observed rather than
    argued: 0.7.1 declared no annotations, so both of its tools were refused and the catalog was
    empty.
  - **the fleet was changed under a live session**, which is the capability a static config cannot
    have at all. One connector process was held open throughout while demo-app was stopped and
    started again: `notifications/tools/list_changed` arrived on the first poll tick after each
    transition — 27s after the stop, 10s after the start, both inside the 30-second interval — the
    tool list emptied and refilled, and the client was never restarted.
- **A stock client connected on 2026-08-16.** Registered with `claude mcp add hosty -- hosty mcp
  --user <email>`; `claude mcp list` spawns the server, completes the MCP handshake and reports
  `✔ Connected`. That is the first evidence about *client compatibility* rather than about the server —
  every check above drove the protocol with a purpose-built driver, which proves the server completely
  and compatibility not at all, the same distinction [app-mcp](../app-mcp/feature.md) drew about its
  own endpoint.
  What the stored entry contains is the headline: `{"type":"stdio","command":"hosty","args":["mcp",
  "--user","…"],"env":{}}` — **no token, no header, nothing that expires**, and `claude mcp get` prints
  it back with nothing to redact. Set against the cost the umbrella recorded for step 6 — a full-role
  admin token in plaintext that `claude mcp get` echoes unmasked — that is the problem this feature
  was built to remove, measured in the same place it was found.
- **A session called an app's tool through that client on 2026-08-16**, which is the last link and
  the whole point. The model was asked for `get_my_app_role`'s `source` field and its permission
  count rather than its role, deliberately: `admin` is guessable from context and would have proved
  nothing, while `host-admin-bootstrap 7` matches demo-app's own answer exactly and cannot be
  arrived at any other way. This closes the step 6 cell that was **not reachable at all** with a
  static config, since the app endpoint wants a five-minute token.
- Every check above registered the server with `claude mcp add`, so the coverage stops at the
  connector: the plugin bundle and the skill are not part of what has been exercised. Carried as an
  unchecked deliverable in [plan.md](plan.md), which is where unfinished work belongs.
