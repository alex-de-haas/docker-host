# App-Provided Skills

Created: 2026-08-20
Updated: 2026-08-20

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

## There Is No Separate Switch

A skill follows its app's MCP provider toggle. Enabling a provider already accepts that this app's
text enters the model's context — a tool arrives with its name and description, and there is no
version of it that does not — so a second toggle would ask the operator the same question twice about
the same app on the same page. An operator who cannot explain the difference between two switches is
looking at a design error.

Two things this replaced, both wrong and worth recording because they read as reasonable:

- **There is no platform-level provider policy** to store a skill flag beside. `mcpProviders` belongs
  to the **gateway**, one app among others, which can be uninstalled. Policy about what an app may put
  in a model's context cannot live inside another app that might not exist.
- **The connector's lack of an operator toggle is not a gap.** `hosty mcp` is the CLI, reaching Core
  over the local control channel, which already carries unconditional host-operator power. A gate
  there would refuse someone who can already remove the app.

## Reaching An Agent

| Reader | Condition | Path |
| --- | --- | --- |
| The Hosty assistant | the provider is enabled **and** the session actually got its tools | `GET /api/internal/apps/{caller}/agent-skills/{target}` |
| `hosty mcp` | the app contributed tools to the catalog | `GET /control/v1/apps/{appId}/agent-skill` |

Both are keyed off **tools the client actually has**, never off policy alone: instructions for tools a
session does not have read as a capability rather than as an absence.

**The app-to-app route had to earn its authorization.** Every other `/api/internal/apps/{appId}/…`
route answers about the caller itself — the service token is validated against the id in the path,
which is what stops an app asking Core about its neighbours. Reading a skill crosses that line, so
only an app declaring the `ai-gateway` interface may cross: nothing else has a reason to read a
neighbour's instructions, and "cheap to allow" is how a torrent client ends up reading the media
server's. The narrower-looking alternative — folding skills into the fleet listing every app already
reads — would have granted this to all of them silently.

The control route needs no such gate, for the reason above.

## Attribution Is The Contract

Wherever a skill lands, the reader's own text comes **first and unwrapped** — the operator's system
prompt in a session, the connector's own instructions in a client. An app must not be able to appear
above the text that describes the surface, because there it reads as the operator or the host
speaking.

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

## Testing Expectations

- **Manifest validation as pairs**: every escaping shape refused beside a legitimate path accepted,
  non-markdown refused, and a manifest declaring no `agent` block unaffected.
- **The cross-app gate as a pair**: an app declaring `ai-gateway` allowed beside an ordinary app
  refused — a route that answers nobody satisfies the negative alone while being broken. Verified that
  the interface check is what refuses, by removing it and watching the pair fail.
- **Anonymous and foreign-token callers refused**, since the caller is who the token says and never
  who the URL says.
- **A declared-but-unpackaged skill is an absence, not a server error.**
- **Composition**: the reader's own text first and unwrapped, every skill attributed, the preamble
  present, and the per-app cap enforced — asserted for a session prompt and for the connector's
  instructions, each beside the no-skill case that must stay clean.
- **Not covered**: that a provider toggled *off* contributes no skill is asserted structurally (skills
  are keyed off the servers a session received) rather than through a session-level test, because the
  gateway's suite has no harness that builds a session against a live provider set.
