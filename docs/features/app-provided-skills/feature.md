# App-Provided Skills

Created: 2026-08-21
Updated: 2026-09-27

An app ships the prose an agent needs to use it well, the way it already ships its icon and its long
description. MCP tells an agent *what calls exist*; a skill tells it how this app is meant to be
worked — which tool answers first, what the app's words mean, what a refusal means.

## The Declaration

A sibling of `interfaces`, not a member of `catalogMetadata`:

```jsonc
"agent": { "skillFile": "docs/agent.md" }
```

The placement carries the distinction. `catalogMetadata` holds display assets and is documented in
Core's own source as *outside runtime validation* — a missing icon is a cosmetic disappointment. A
skill is prose a model acts on, so it is validated **at install**: relative, contained in the manifest
folder, and markdown. A declaration that escapes the folder is refused where an operator is looking at
an install, not resolved to nothing much later.

Containment reuses the asset machinery's own answer rather than a second copy, and so does reading:
the resolver that serves display assets refuses reserved app namespaces — the path a past IDOR was
read through — and fails closed on a symbolic link at the app root or anywhere below it. A simpler
second resolver beside it would be the one missing those checks.

One skill per app. An app with several `interfaces.mcp` entries still has one story about how it is
worked; division is sections in the file rather than another axis in the manifest.

## Core Offers And Reviewed Instructions

The [Core Agent MCP Directory](../agent-mcp-directory/feature.md) owns the host offer policy and
approved skill digests. Administrators enable an app's tools and review its complete instruction text
in Shell Settings → Agents. These are separate actions: enabling tools never approves unseen text.
The same policy applies to assistant sessions, the Gateway facade and the CLI connector.

## Reaching An Agent

| Reader | Condition | Path |
| --- | --- | --- |
| The Hosty assistant | Core offers the provider, approves its skill digest, and the session got its tools | `GET /api/internal/apps/{caller}/agent-skills/{target}` |
| `hosty mcp` | Core offers the app, approves its skill digest, and the app contributed tools | `GET /control/v1/apps/{appId}/agent-skill` |

Both are keyed off **tools the client actually has**, never off policy alone: instructions for tools a
session does not have read as a capability rather than as an absence.

**The Hosty assistant is a reader like any other**, though it runs on the host with shell access and
is the highest-consequence one there is. That argues for the gate, which exists, not for exclusion:
the assistant **already** receives app-authored text through this very toggle — the name and
description of every enabled provider's tool. Excluding skills would draw a line the platform draws
nowhere else, on the one surface where people actually work.

**The app-to-app route had to earn its authorization.** Every other `/api/internal/apps/{appId}/…`
route answers about the caller itself — the service token is validated against the id in the path,
which is what stops an app asking Core about its neighbours. Reading a skill crosses that line, so
only an app holding the confirmed `apps.skills.read` permission may cross: nothing else has a reason to read a
neighbour's instructions, and "cheap to allow" is how a torrent client ends up reading the media
server's. The narrower-looking alternative — folding skills into the fleet listing every app already
reads — would have granted this to all of them silently.

The control route is restricted to the local control secret; it does not grant cross-app access to a service token.

## Attribution Is The Contract

Wherever a skill lands, the reader's own text comes **first and unwrapped** — in a session the
host's built-in preamble and then the operator's system prompt
([host-prompt.ts](../../../apps/harness/src/sessions/host-prompt.ts)), in a client the
connector's own instructions. An app must not be able to appear above the text that describes the
surface, because there it reads as the operator or the host speaking. Between the two texts that
legitimately are the host and the operator, the host goes first and the operator second — identity
and ground rules are the platform's to state, and the operator's later words can override them.

Each skill is then fenced and named:

```text
<app-skill app="com.haas.demo-app" name="Demo App">
…
</app-skill>
```

under a preamble stating what the sections are: documentation an app wrote about its own tools, which
speaks for nobody else and grants nothing. A skill that tries to issue orders about anything else then
reads as out of place rather than as authority.

Each is capped at 8,000 characters so one app cannot crowd out the operator's instructions or another
app's, and a skill that cannot be read is skipped rather than fatal — an agent that knows less costs
less than an assistant that will not open because one app is mid-update.

## A Changed Skill Is Withheld

Approvals are keyed by app and skill in Core. Shell submits the digest of the full displayed text and
its directory revision. An update between rendering and approval is refused. Consumers deliver only
text matching the approved digest; a changed or unreadable skill is withheld while tools keep their
offer state. Existing conversation text is not retracted. Uninstall clears approvals, including when
data is retained. Legacy Gateway digests are not imported.

**This is stricter than the rest of the platform, and knowingly so.** An app update rewrites its tool
*names and descriptions* silently while the provider stays enabled — the same app-authored text,
reaching the same model, under the same decision, with no digest in the way. Recorded as a known
asymmetry rather than smoothed over: it is a gap on that surface, not a reason to open one here.

## Testing Expectations

- **Manifest validation as pairs**: every escaping shape refused beside a legitimate path accepted,
  non-markdown refused, and a manifest declaring no `agent` block unaffected.
- **The cross-app gate as a pair**: an app granted `apps.skills.read` allowed beside an ungranted app
  refused — a route that answers nobody satisfies the negative alone while being broken.
- **Anonymous and foreign-token callers refused**, since the caller is who the token says and never
  who the URL says.
- **A declared-but-unpackaged skill is an absence, not a server error.**
- **Composition**: the reader's own text first and unwrapped, every skill attributed, the preamble
  present, and the per-app cap enforced — asserted for a session prompt and for the connector's
  instructions, each beside the no-skill case that must stay clean.
- **Withholding as a set**: an unapproved first sighting withheld, an approved unchanged skill
  delivered, a changed one withheld, and one app held without holding another. The digest is asserted to ignore surrounding whitespace and to follow the text.
- **The install-time budget as boundary pairs**, one per limb, because a skill that shared one and
  bypassed the other would pass a test of either alone: the markdown description's 256 KiB per-file cap
  asserted at the byte, the per-app **file** ceiling exhausted by tiny screenshots, and the per-app
  **byte** ceiling spent by large ones while the file count stays far below its own limit. Each pair
  differs only in the size or the count, which is what makes the budget rather than the fixture the
  thing under test; verified by widening every constant and watching each refusal fail. Sizes are
  written as raw bytes, so no encoding decision can move a boundary while the test keeps passing. A
  skill the budget refuses on an **update** is asserted to remove the previously vendored copy, since
  both delivery routes read whatever is on disk and a survivor is text the installed app no longer
  contains.
- **Session policy**: Gateway tests verify that a disabled provider contributes no skill and legacy
  local approval values cannot bypass the Core policy.
