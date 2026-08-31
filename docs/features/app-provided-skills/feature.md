# App-Provided Skills

Created: 2026-08-21
Updated: 2026-08-31

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

**The Hosty assistant is a reader like any other**, though it runs on the host with shell access and
is the highest-consequence one there is. That argues for the gate, which exists, not for exclusion:
the assistant **already** receives app-authored text through this very toggle — the name and
description of every enabled provider's tool. Excluding skills would draw a line drawn nowhere else,
on the one surface where people actually work.

**The app-to-app route had to earn its authorization.** Every other `/api/internal/apps/{appId}/…`
route answers about the caller itself — the service token is validated against the id in the path,
which is what stops an app asking Core about its neighbours. Reading a skill crosses that line, so
only an app declaring the `ai-gateway` interface may cross: nothing else has a reason to read a
neighbour's instructions, and "cheap to allow" is how a torrent client ends up reading the media
server's. The narrower-looking alternative — folding skills into the fleet listing every app already
reads — would have granted this to all of them silently.

The control route needs no such gate, for the reason above.

## Attribution Is The Contract

Wherever a skill lands, the reader's own text comes **first and unwrapped** — in a session the
host's built-in preamble and then the operator's system prompt
([host-prompt.ts](../../../apps/ai-gateway/src/sessions/host-prompt.ts)), in a client the
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

Enabling a provider is consent to that app's prose **as it stands**. It cannot be consent to whatever
the publisher writes next, and an update rewrites the file under the same path — so without this, new
instructions would reach the model on the strength of a decision made about different words.

The approval is a digest per app in the gateway's settings, beside the provider toggle that already
carries the operator's decision. Not a per-app flag: that was tried and removed as a second question
about one trust, and reviving it here would have brought the question back.

- **The baseline is taken when the provider is enabled**, not at first delivery. Recording it on
  first sight looked equivalent and was not: an operator enabling while the app shipped one text, and
  the app updating before the first session, would have had the new words delivered and self-approved
  — the substitution this exists to stop, arriving through its own baseline. An app whose skill cannot
  be read at that moment gets no baseline and is withheld until approved.
- **A change is withheld** and appears on the settings page **with its new text** — approving prose
  you cannot read is not approval, and a diff would still hide what the whole now says.
- **Approval names the text that was on screen.** The digest travels with the click, so an update
  landing between the render and the press is refused rather than approved: "approve whatever is
  current" would approve words nobody read, which is this mechanism's own failure arriving through
  its approval path.
- **The digest is over the text**, not the path or the version: an app that rewrites its skill without
  bumping anything is caught, and one that moves an unchanged file is not.
- Holding one app holds nothing else.
- **Digests are merged inside the store, never by the caller.** `update` replaces a field wholesale,
  so a caller merging on its own reads outside the serialized section — where two writers lose one of
  the two, and a digest silently absent later reads as "this app changed" and withholds a skill nobody
  touched.

The connector is unaffected. `hosty mcp` runs on the local control channel, which already carries
host-operator power, so it has no toggle to hang an approval from and needs none.

**This is stricter than the rest of the platform, and knowingly so.** An app update rewrites its tool
*names and descriptions* silently while the provider stays enabled — the same app-authored text,
reaching the same model, under the same decision, with no digest in the way. Recorded as a known
asymmetry rather than smoothed over: it is a gap on that surface, not a reason to open one here.

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
- **Withholding as a set**: a first sighting delivered and recorded, an unchanged skill still
  delivered, a changed one withheld with nothing recorded for it, and one app held without holding
  another. The digest is asserted to ignore surrounding whitespace and to follow the text.
- **The install-time budget as boundary pairs**: a skill exactly at the markdown description's 256 KiB
  per-file cap vendored beside one a single byte past it refused, and — with the display assets spending
  the per-app ceiling first — a skill that still fits beside one that no longer does. Each pair differs
  only in the size or the count, which is what makes the budget rather than the fixture the thing under
  test; verified by widening both constants and watching every refusal fail. A skill the budget refuses
  on an **update** is asserted to remove the previously vendored copy, since both delivery routes read
  whatever is on disk and a survivor is text the installed app no longer contains.
- **Not covered**: that a provider toggled *off* contributes no skill is asserted structurally (skills
  are keyed off the servers a session received) rather than through a session-level test, because the
  gateway's suite has no harness that builds a session against a live provider set.
