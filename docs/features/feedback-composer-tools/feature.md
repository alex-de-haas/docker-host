---
created: 2026-11-02
updated: 2026-11-04
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
one provider opens the ordinary picker. Standalone apps use their existing tool workspace. Below
the standard SDK docking breakpoint, the composer stacks below the active document without making
it inert; selection remains available in Desktop root and standalone layouts.

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
source wins and all other pickers cancel. A pick request with no mode defaults to element selection. Visibility changes refresh retained composer source lists.
Metadata, annotation count and image payloads are bounded. Providers receive no credentials,
arbitrary DOM, input values or unrelated source drafts. A submit request must match the chosen
source's Core/app/installation/user key; the source adapter and Core revalidate intake authority.
The form supplier and feedback target are independent identities.

## Form And Storage

Harness owns comment editing, explicit local saving, screenshot attachment/removal, dictation, discard and frozen
submission retry. Its IndexedDB database is `hosty-feedback-composer-v1`; keys identify the target
Core/app/installation/account. Writes check saved revision and request identity in one transaction.
Target changes wait for local writes and cannot silently abandon a storage failure. Different
providers have separate origin-local drafts. One report never combines multiple target apps.

Annotation comments and the optional overall comment use the same input-group components as the
Harness chat composer. A microphone icon sits inside each field. Annotation fields also have a
screenshot icon on the left, a Save comment control with a local-save confirmation, and the shared chat attachment card with a
thumbnail, size and removal action. Screenshots remain attached to their individual annotations.
Local-save confirmation applies only to the same draft identity and revision that initiated Save;
editing during a pending write prevents an older save from acknowledging the newer text.
The form loads one speech-provider roster and permits one dictation operation at a time. A transcript
belongs to the field that started recording, even if another field receives focus or its callback
changes. Target switching, screenshot actions, removal and submission wait for dictation to finish
or be cancelled. Closing the form, changing accounts or disabling the draft cancels the recorder
and ignores late results. The existing scoped feedback speech endpoint supplies recognition.

On opening a target, the composer can recover its old `hosty-feedback-v1` source draft through the
verified channel. It stores that draft, including images and retry identity, before requesting a
revision-checked deletion of the source copy. Conflicting provider/source drafts remain separate;
the form explains how to recover the retained source copy after finishing the current draft.
Storage errors preserve the source recovery copy. SDK legacy code only reads/deletes old drafts;
new draft persistence belongs to the provider.

Harness enables **Include screenshot** by default for Select element, Select region and Page comment.
The button gesture synchronously calls the SDK's `captureScreen` helper, retaining browser activation.
The browser asks the user to choose a screen, window or tab; it does not grant persistent capture
permission. After consent, the source picker runs. The first selection arrives before the broker's
end-of-selection event, so the provider can distinguish a completed pick from cancellation.

The SDK temporarily outlines the chosen element or region in its own document. An element outline
follows the actual element through layout changes. The form inserts the new comment only after
capture finishes, so feedback on the provider itself preserves the selected DOM until the frame. The outline survives focus leaving the iframe, clears after capture/cancellation and
expires if the provider disappears. The provider captures one complete frame of the chosen surface,
without automatic iframe cropping, then stops every media track. It does not promise that an unrelated
surface chosen in the browser dialog contains the annotated app. Page comments have no outline.

After browser permission and capture, Harness attaches the complete, uncropped image directly to the
local annotation draft. There is no second review/crop dialog. The attachment thumbnail and removal
control let the user inspect or remove it before explicitly submitting the report. Retake screenshot
replaces the image after a successful capture; a failed retake preserves the previous image. Retakes
restore the source outline from the retained selection. A removed target, changed route or restored
annotation without its live selection asks for a new selection instead of attaching an unmarked image. Declining
capture, disabling Include screenshot, or using a browser without capture support leaves text comments
available. Images above the per-image or report byte limits are rejected with a visible explanation;
the comment and any previous images remain intact.
Cancellation, source/account loss, a hidden provider, unmount and a two-minute selection timeout stop
capture; late permission grants are stopped without taking a frame. The lower-level `captureStill`
helper and source CropTarget operation remain available for providers that explicitly choose cropping.
See [Feedback intake](../app-feedback-inbox/feature.md) for Core storage and review semantics.

## Verified Acceptance

The 2026-11-02 macOS/Chrome managed-child run passes authenticated intake, immutable source
context, replay, draft persistence, Shell pinning/concurrent panels, host/iframe hover handoff,
provider self-feedback and Desktop window/root target isolation. Actual browser capture is used;
the test reads PNG pixels to verify element and region outlines, checks full initial tab dimensions
and verifies that iframe captures retain the host's full width. Form self-feedback captures before
switching drafts, including selection of disabled fields. Full images attach without a second dialog.

The command is `npm run test:integration -- feedback`, with `HOSTY_FEEDBACK_BROWSER_ONLY=1`,
`HOSTY_FEEDBACK_DESKTOP=1` and `HOSTY_FEEDBACK_RETRY_BROWSER=1`. The final run uses normal password
login and Core launch-code identity. The first browser attempt times out during Desktop's initial session recovery; the retry in the
same managed child passes. Inline microphone/capture controls and removable attachment cards stay
inside the comment field in standalone, Shell and Desktop. Cold startup is 27.522 seconds, warm
restart is 2.034 seconds without reinstalling or rebuilding, and missing-output recovery is 22.198 seconds. Parent Finish verifies child removal; the fixture
verifies stopped services, helper/Git server processes and closed ports before removing test data.
Earlier diagnostic fixtures are finished and removed after exporting their useful test results.

`npm run sdk:test` passes 748 tests; `npm run harness:test` passes 2,028 tests. SDK compilation,
published overlay/hydration checks, `npm run harness:lint`, the Harness production build, version
consistency, documentation validation and whitespace checks pass. Harness retains one pre-existing
lint warning in `tasks.tsx`. Core and CLI compile as integration prerequisites. Speech cancellation and transcript routing use mocked media/provider responses in unit tests; no
audio is sent to a live speech provider for this form change. Agent dispatch is
not rerun for this UI change; other operating systems and native webviews are outside this
run. Manual inspection of the already-open in-app browser is unavailable because its tab binding
reports an unavailable browser connection; managed Chrome provides the browser acceptance evidence.

SDK version is 0.41.0 (from 0.40.0); Harness and its worker are 0.85.0 (from 0.84.0).
The authorized live trial runs Core, Shell, Harness and Desktop from the registered workspace.
The live Core catalog exposes the declared Feedback panel, and the signed-in Shell opens it from
the common Tools list with the normal pin control. The form independently identifies Shell and
its own provider page as feedback targets. Trial activation does not publish packages or commits.

## Testing Expectations

- Core tests cover explicit declaration, ordinary panels, unrelated app identities, catalog and
  resolved surfaces, access and installation checks, plus empty-app discovery.
- SDK tests cover unregistered/undeclared callers, wrong actors/nonces/origins, source replacement,
  hidden sources, workspace isolation, result-before-completion ordering, stale hover handoff,
  abort/source-end cleanup, outline expiry/reflow and suppression of only the selected target click.
- Harness tests cover migration ordering and conflicts, storage failures, source attribution,
  preserved retry identity across reload, app-owned form editing, consent-before-selection ordering,
  capture cancellation/timeout, deferred self-selection, direct full-image persistence, removal/retake,
  byte limits and late captures after account changes. Dictation tests cover a shared roster,
  independent field destinations, cancellation during microphone permission or transcription,
  disabled drafts and unmount cleanup.
- Managed browser acceptance uses normal login in a separate child Core and exercises screenshots,
  transactional stale writes, Shell concurrent tools, iframe/host selection, provider self-feedback,
  compact restoration and Desktop window/root boundaries. Finish removes test resources.
- Build affected SDK, Core and consumers; validate versions and docs. Run the SDK published-package
  overlay upgrade check so both single-quoted and double-quoted relative imports resolve in Node ESM.
  Live workspace activation is an explicitly authorized trial and does not follow automatically from
  sandbox success.
