---
status: Draft
created: 2026-10-20
updated: 2026-10-20
summary: Typed app-owned object links with Core target resolution and SDK host placement, leaving shared-object viewers and defaults as separately approved extensions.
components: [apps/core, apps/shell, apps/harness, packages/app-sdk]
---

# Object Links

## Goal And Scope

Open an app at the referenced object from Dashboard, another app or an assistant's
message. Core determines the eligible app/target; the current Shell or standalone SDK
host determines presentation using existing composition. This is a Draft requested
on 2026-10-20, not implementation approval.

Start with app-owned links, including Harness sessions. Do not make cross-Core
routing or a default-applications framework a prerequisite. Do not insert a mandatory
Core ID into every logical reference. Existing Core-relative HTTPS launch URLs can
bind a local reference to a particular host when sharing that context is intended.

## Proposed Contract

A typed reference carries an app namespace, object kind, object identifier and optional
view intent. For example, a Harness session reference belongs to Harness. A movie
reference belongs to the registered media app; an external ID also states its namespace
(for example TMDb movie versus TV). These are semantic examples, not approved URI grammar.

The manifest declares named link kinds and supported view parameters. Resolve only
registered targets; do not interpolate arbitrary URLs, filesystem paths or executable
code from a link. Treat IDs and parameters as untrusted data and validate/encode them.
Link registration does not grant data access or authorize starting a stopped app.

Core resolves against current installation, user access, declared kind and readiness.
An unavailable app/object produces a clear outcome; it never silently opens another
user's or assistant's object. A reinstallation cannot reuse stale execution grants.
Resolution reads do not create sessions, tools or credentials.

The SDK supplies link construction and navigation helpers and intercepts only its
supported links within participating app UI. External ordinary links retain browser
behavior. Preserve copy/open-separately and modifier-key behavior with a real usable
href/fallback. A custom `hosty:` scheme alone is not a complete browser solution:
without an installed handler it cannot provide that fallback.

Delegate resolved presentation to [SDK UI composition](../sdk-ui-composition/feature.md)
and the [panel system](../sdk-panel-system/feature.md). A standalone app can host a
panel too. The link expresses a target/view; it does not mandate a new tab, a side,
or a specific Shell. Reuse an exact existing target according to host policy and
preserve separate conversations.

## Ownership And Defaults

App-owned links select that app explicitly. Defaults apply only to neutral references
for genuinely shared objects or new unbound operations. A shared Core workspace could
later use a preferred viewer, while a Harness workspace link explicitly requests
Harness. Existing session links always retain their assistant owner.

[Default applications](../default-applications/plan.md) owns preference storage and
selection; this feature must not invent another default store. A default assistant
for a new question and a session's owner are different facts. Cross-assistant
history/session transfer is outside this plan.

A portable external movie ID may resolve in another host's media app if supported.
Missing media has a deliberate unavailable result or that app's own catalog detail,
not an implicit download or server-to-server request. Local object IDs have no
cross-host equivalence promise. Federation and linking arbitrary remote Core users
are out of scope.

## Deliverables

- [ ] D1. Finalize and approve the URI/reference grammar, HTTPS fallback, registration and compatibility contract with explicit local versus portable ID semantics.
- [ ] D2. Implement app-owned manifest declarations, permission-aware Core resolution and structured unavailable outcomes without granting lifecycle authority.
- [ ] D3. Add SDK link construction/navigation and Shell/standalone presentation integration, including ordinary browser link affordances.
- [ ] D4. Integrate the first complete Harness session/workspace link journey and verify generated links in assistant messages and Dashboard/contextual UI.
- [ ] D5. Verify access, lifecycle, stale-installation and browser fallback behavior in a Core-managed sandbox; document the contract and update versions/index.

## Open Decisions And Later Scope

Choose the URI grammar and browser fallback before implementation; settle whether the
first increment includes neutral Core workspace links or only explicit Harness links.
Neutral viewers are an extension to coordinate with the defaults feature, not an
unfinished hidden part of the app-owned contract. Inventory actual session ownership
in Harness; do not invent a universal Core session model.

## Verification

Cover escaping and malformed IDs, inaccessible objects/apps, missing installations,
stopped apps, app updates/reinstalls, arbitrary redirect attempts, modifier clicks,
copying and opening outside Shell. Verify an explicit session keeps its provider
after default changes, and standalone panel placement works without a Shell.
