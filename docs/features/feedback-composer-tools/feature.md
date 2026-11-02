---
created: 2026-11-02
updated: 2026-11-02
summary: App-provided feedback tools own forms and drafts while verified SDK source services supply selection, capture and scoped intake.
components: [apps/core, packages/app-sdk, apps/harness, apps/shell, apps/desktop]
---

# Feedback Composer Tools

A feedback composer is an ordinary `ui.panels` entry with `feedbackComposer: true`. Core preserves
this explicit declaration in the panel catalog and resolved surface. It never discovers a provider
by application ID, vendor, label or internal route. An empty registry supplies no composer.

Harness declares `/feedback-panel` as its Feedback tool. Shell lists and pins it normally; the
special SDK form and host-only menu entry are absent. Desktop window tools use the same catalog.
Desktop's menu-bar shortcut resolves declared providers into its root tool workspace; more than
one provider opens the ordinary picker. Standalone apps use their existing tool workspace.

## Provider Integration

An app adds its form as a normal manifest panel, using its own endpoint and route:

```json
{
  "id": "feedback",
  "label": "Feedback",
  "endpoint": "web",
  "path": "/feedback-panel",
  "feedbackComposer": true
}
```

The page mounts the normal SDK UI root and calls `connectFeedback(receive)`. The returned port
accepts requests and must be closed when the form unmounts. `sources` events expose eligible target
metadata; `selection` events return the source and a note; `picking` events drive the cancel UI.
The provider stores drafts keyed by `feedbackScope(source.capabilities)` and submits them with
`{ action: "submit", sourceId, draft }`. Drafts use structured-cloneable image Blobs, not credentials.
The source adapter performs the authenticated intake request. An undeclared panel receives no port
authority even when its application supplies another declared composer.

## Source And Provider Boundaries

`@hosty-sdk/app/feedback/client` exposes `connectFeedback`, source metadata, source-scoped requests,
selection events and capture helpers. It renders no form. Each source document registers only its
own authenticated capabilities. The host verifies the frame's origin, user, application,
installation, nonce and generation before accepting that registration. Only a visible mounted
composer declaration enables provider requests. Closing, changing accounts or navigating the frame
retires pending operations. A Desktop window exposes its own workspace sources; the root workspace
can select host chrome and visible application frames. Hidden source documents are unavailable. A verified composer may finish loading while its retained
frame is hidden; its subscription stays registered but exposes no sources or operations until the
panel is visible. Refreshing its own capture capabilities does not disconnect that subscription.

The broker supports source discovery, element/region picking, cancellation, page context,
highlighting, browser crop targets, legacy draft recovery and scoped submission. The first selected
source wins and all other pickers cancel. Visibility changes refresh retained composer source lists.
Metadata, annotation count and image payloads are bounded. Providers receive no credentials,
arbitrary DOM, input values or unrelated source drafts. A submit request must match the chosen
source's Core/app/installation/user key; the source adapter and Core revalidate intake authority.
The form supplier and feedback target are independent identities.

## Form And Storage

Harness owns comment editing, Done, local saving, preview/cropping, dictation, discard and frozen
submission retry. Its IndexedDB database is `hosty-feedback-composer-v1`; keys identify the target
Core/app/installation/account. Writes check saved revision and request identity in one transaction.
Target changes wait for local writes and cannot silently abandon a storage failure. Different
providers have separate origin-local drafts. One report never combines multiple target apps.

On opening a target, the composer can recover its old `hosty-feedback-v1` source draft through the
verified channel. It stores that draft, including images and retry identity, before requesting a
revision-checked deletion of the source copy. Conflicting provider/source drafts remain separate;
the form explains how to recover the retained source copy after finishing the current draft.
Storage errors preserve the source recovery copy. SDK legacy code only reads/deletes old drafts;
new draft persistence belongs to the provider.

A screenshot starts synchronously from the provider's explicit button so browser activation is
retained. A source-generated CropTarget can constrain the selected track to that application.
Unsupported or rejected cropping uses explicit preview/manual cropping. Inclusion is always an
app-owned confirmation. Select region records geometry; it does not automatically capture an image.
See [Feedback intake](../app-feedback-inbox/feature.md) for Core storage and review semantics.

## Verified Acceptance

The 2026-11-02 macOS/Chrome managed-child run passes authenticated intake, immutable source
context, replay, Harness-owned draft migration and persistence, screenshot review, Shell pinning
and concurrent panels, host/iframe hover handoff, provider self-feedback and Desktop window/root
target isolation. Desktop acceptance also opens Pull requests as its own tool, verifies a single
selected toolbar icon, selects an element in the application window and restores Feedback after
switching tools. The run uses normal password login and Core launch-code identity, including the
normal Desktop Retry path after an initial session request failure.

The command is `npm run test:integration -- feedback`, with `HOSTY_FEEDBACK_BROWSER_ONLY=1`,
`HOSTY_FEEDBACK_DESKTOP=1` and `HOSTY_FEEDBACK_RETRY_BROWSER=1`. Cold startup is 26.247 seconds,
warm restart is 1.968 seconds without reinstalling or rebuilding, and missing-output recovery is
21.735 seconds. Parent Finish verifies removal of the child, local services, helper, Git server,
ports and test credentials/data. This acceptance covers browser feedback intake; agent dispatch is
not rerun because its existing fake-Codex fixture has an unrelated exact-prompt assertion failure.
Other operating systems and native webviews are outside this run.

Affected unit suites pass: SDK 735, Harness 2,007, Shell 805 component plus 207 Node tests,
Desktop 34, and 237 Core manifest/contract/HTTP tests. After the final Harness panel-readiness change, its
seven focused composer/speech tests, web lint/types, production build and managed browser suite
pass again. SDK, Shell, Desktop, Harness, exact Core and CLI builds pass. Documentation, version
consistency and whitespace checks pass; pre-existing Shell/Harness lint warnings remain unchanged.

The authorized live trial runs Core, Shell, Harness and Desktop from the registered workspace.
The live Core catalog exposes the declared Feedback panel, and the signed-in Shell opens it from
the common Tools list with the normal pin control. The form independently identifies Shell and
its own provider page as feedback targets. Trial activation does not publish packages or commits.

## Testing Expectations

- Core tests cover explicit declaration, ordinary panels, unrelated app identities, catalog and
  resolved surfaces, access and installation checks, plus empty-app discovery.
- SDK tests cover unregistered/undeclared callers, wrong actors/nonces/origins, source replacement,
  hidden sources, workspace isolation, first-selection cancellation and stale hover handoff.
- Harness tests cover migration ordering and conflicts, storage failures, source attribution,
  preserved retry identity across reload, and app-owned form editing.
- Managed browser acceptance uses normal login in a separate child Core and exercises screenshots,
  transactional stale writes, Shell concurrent tools, iframe/host selection, provider self-feedback,
  compact restoration and Desktop window/root boundaries. Finish removes test resources.
- Build affected SDK, Core and consumers; validate versions and docs. Live workspace activation is
  an explicitly authorized trial and does not follow automatically from sandbox success.
