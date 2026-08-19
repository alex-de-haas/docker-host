# App UI Surfaces

Created: 2026-08-19
Updated: 2026-08-19

An app declares **where** its pages belong, and Shell places them. Before this, an app had exactly
one placement — the sidebar — so operator configuration, domain work, and always-at-hand tools all
competed for the same list.

## The Three Placements

Chosen by **who the page is for and what it changes**, not by whether it looks like settings:

| Manifest field | How many | Audience | Where it lands |
| --- | --- | --- | --- |
| `ui.navigation` | any | users | the shell's sidebar |
| `ui.settings` | at most one | administrators | a tab on Shell's Settings page |
| `ui.panels` | any | users | tabs on Shell's right panel |

Litmus tests: *would a `host.user` ever legitimately open it?* → sidebar or panel. *Does it change
behaviour rather than produce and consume content?* → settings.

Both new fields are additive under `app.0.1` with no `schemaVersion` bump — that number tracks the
contract format, not additions to it. Core resolves each surface to a URL exactly as it resolves a
navigation entry, so Shell discovers placements without reading manifests.

**`ui.settings` is singular and `ui.panels` is a list, deliberately.** One app has one place its
operator configuration lives; the same app may ship several distinct tools, and a strip of tabs is
where they belong. The fields stay per-kind rather than collapsing into one `ui.surface`, leaving
room beside them for kinds not built yet.

**Strict validation is a system-app rule.** For `role: system` the endpoint must exist and be
explicit, paths absolute, every panel labelled and labels unique within the app — its pages render as
administrator Shell surfaces, so it must not lean on the permissive fallbacks ordinary `app.0.1`
manifests keep for compatibility. An ordinary app keeps those fallbacks, so Shell supplies a label
for a panel that declared none.

## Placement Is Not Access Control

A declaration says where a page is shown, and nothing else. The page stays reachable standalone
(`hosty apps open`), and being embedded grants it nothing — the app keeps enforcing its own
authorization on every request.

The direct-link question this raises has a better answer than expected for system apps: Core's
`RequireAccessibleUserAsync` runs on **every** identity flow including revalidation, so it refuses a
non-administrator a session for a system app at all, and a downgraded administrator loses access at
the next revalidation rather than the next login. The app does not have to remember to check. An
ordinary app gets no such rule, and its own authorization decides — which is the app's
responsibility, stated as such in the skill reference.

## Embedded Surfaces Authenticate Like Every Other Page

Shell mints a launch code and the frame lands with a real Hosty app session, exactly as a sidebar
page does. This is the part that is easy to get subtly wrong: embedding Core's resolved endpoint URL
directly produces a frame with **no** session, and an app authenticating the ordinary way then loads
unauthenticated and cannot recover, because `hosty:auth-required` recovery is scoped to the active
workspace.

So the mechanism is shared rather than copied, at two levels:

- **`EmbeddedAppFrame`** — one embedder for every context Shell embeds an app in: the workspace, a
  Settings tab, a panel tab. It owns the theme post, auth recovery, the delegated-token handshake,
  and the mixed-content refusal.
- **`useAppSurfaceSrc`** — one launch-code exchange for every placed surface, including the
  stale-answer rule: an answer belongs to the surface it was minted for, so a slow response for a tab
  the operator has left cannot land under the label of the one they are looking at.

A copy per context is how the gap this replaced happened: only the workspace answered the
delegated-token handshake, so a settings page embedded elsewhere never loaded at all.

**Recovery is the placed surface's own.** When a frame reports `hosty:auth-required`, the workspace's
recovery re-mints against the workspace's URL and does nothing unless the centre pane belongs to that
same app — so a panel docked beside a Shell page, or beside a *different* app, could never recover
and would sit unauthenticated until it was remounted. A placed surface re-mints its own code instead,
behind the same per-app rate limiter, since a frame that never accepts the new code must not drive an
unbounded reissue storm. The previous answer stays on screen until the new one lands, so recovery
does not blank the tool being used.

The gateway used to be the one app that authenticated differently — a delegated token where every
other app used a session. It now uses a session for its settings page and keeps the delegated token
only for the Shell assistant panel, which is a genuinely different client rather than an exception.

## Shell's Chrome

Two rails and a strip, so content stays visible beside its tools rather than under them.

**The right panel** holds `ui.panels` tabs. It is absent entirely while no installed app declares
one — chrome for a capability nobody has is worse than no chrome — and collapsible when they do, with
the choice remembered like the sidebar's. The property that motivated it is **docking**: panel
content sits beside the workspace, so an operator reads an app's error and works with a tool about it
at the same time.

Tabs are keyed rather than indexed, because stopping or removing an app reorders the strip and an
index would then point at somebody else's tool. A stopped app **keeps** its tab, dimmed and saying
why, with a start action offered only to a user who can actually start apps — panels are deliberately
not administrator-only, but Core's start route is, so offering everyone the button would promise
something guaranteed to fail: a surface that vanished with its app would read as uninstalled, and the
operator would go looking for the app rather than starting it. If the chosen tab's app disappears,
the strip falls back to the first rather than rendering blank.

**The top strip** owns what belongs to neither rail: a toggle at each end, and between them the name
of whatever fills the content area — an app's page, or the Shell page — plus the notification bell
and the theme control, both relocated here from the sidebar footer. The right-rail toggle is absent
while the rail does not exist. Apps contribute nothing to the strip; an app that could write there
would be writing outside its frame.

## Current Placements

- **The gateway** declares `ui.settings` and no sidebar entry: its whole page is operator
  configuration. It still declares `ui.entrypoint`, because a system app's `ui` block requires one —
  but an entrypoint no longer buys a place in the sidebar (below).
- **Telemetry** keeps Metrics/Traces/Logs in the sidebar — routine use, possibly by non-admins.
- **Demo App** declares a `Session` panel, which is the platform's worked example of the contract:
  narrow, chrome-free, and showing the session itself, since a panel reporting no session is exactly
  what a broken embedding looks like.
- Core-injected manifest `settings` stay native in Shell — platform-owned state, uniform by
  construction.

### A Sidebar Row Comes From `ui.navigation`, And Nothing Else

An app with no `ui.navigation` has no pages in Shell — no sidebar row, and no entry on the Apps page.
Shell used to derive a "Home" row from `ui.entrypoint` when navigation was absent, and placed
surfaces made the cost of that visible: the gateway declares only `ui.settings`, yet the entrypoint
it is obliged to keep put it back in the sidebar on a row that opened the very page its Settings tab
already hosts.

Declaring UI and having a browsable page are different claims, and only navigation makes the second.
The derived row also had Shell inventing the label "Home" for someone else's app, which is the
opposite of an app saying where its pages belong.

The consequence for app authors is worth stating plainly: **an app that declared only an entrypoint
and relied on the derived row now has to declare navigation** — which the manifest reference has
always asked for. Nothing becomes unreachable by it: `hosty apps open` and an explicit deep link both
still resolve a path against the entrypoint, because asking for a page by name is not the same as
being offered one.

An embedded settings page is given the **whole content column**, background included. An app paints
its own page background, so a muted column around a white frame drew a seam under the tab strip that
no other tab has — and padding around the frame turned the app into a box floating on the page. Shell
already does exactly this for a workspace app; a settings tab is the same claim on the same column.

Shell never learns any app's settings schema. That was the objection that moved the gateway's page
out of Shell in the first place, and hosting an iframe honours it.

## Testing Expectations

- **Tab derivation as a pair**: a declaring app and a non-declaring one in the same fleet, since
  either assertion alone is satisfied by a rule that always answers the same way. Independence of the
  two surfaces is asserted the same way.
- **Several panels from one app** keep their order, their labels, and distinct keys.
- **The label fallback** — app name when a panel declares none, numbered only when the app ships
  more than one, since "Demo App 1" is worse than "Demo App" when there is nothing to tell apart.
- **A stopped app keeps its tab**, carrying the reason rather than vanishing.
- **The active tab survives what it can and falls back rather than pointing at nothing.**
- **Manifest validation both ways** (Core): a surface inherits the entrypoint endpoint or keeps its
  own, paths normalise like every other UI path, declaring one surface says nothing about the other.
- **Verified live** on a host running these versions (2026-08-19), because the property that matters
  most here is not unit-testable: a placed surface must land with a real Hosty app session rather
  than as an anonymous visitor to the app's origin.
  - The panel's `Session` tab reports `status: active`, the operator's own user and `host.admin`,
    and — the part that proves the mechanism — **`tokenSource: cookie`**. An anonymous frame or one
    leaning on a delegated token would say something else.
  - The Settings tab renders the gateway's page *with its data*: the MCP provider list comes from an
    API that answers 401 without a credential, so a page that merely painted would not show it.
  - The strip renders on every page, its toggle collapses the sidebar, the theme control works from
    its new home, and the right-rail toggle is absent until an app declares a panel.
  - The gateway is gone from the sidebar, and — the pair that matters, since the page-link rule is
    shared — an ordinary app page still embeds in the workspace, its frame carrying the launch code,
    `hosty_launch=embedded` and the theme parameters.
  - Measured rather than eyeballed: the content column and the embedded frame resolve to the same
    colour, and a non-app settings tab keeps the page's own surface.
