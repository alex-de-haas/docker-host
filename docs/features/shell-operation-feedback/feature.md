---
created: 2026-09-25
updated: 2026-09-27
summary: Shell separates confirmations, transient operation results and persistent diagnostics.
components: [apps/shell]
---

# Shell operation feedback

Shell separates explicit decisions, transient operation results, and persistent diagnostics.

## Confirmations

Alert Dialog replaces browser confirmation prompts for Core update, Shell stop/restart, backup restoration/deletion/cleanup, and user disabling/deletion. Existing credential revocation, app removal, source discard and Cloudflare disconnect confirmations also use Alert Dialog. Shared mount deletion names the mount and explains the consequences of forcing deletion while bindings exist.

Dialogs preserve the original operation permissions, reviewed plans, removal options, and destructive consequences. Cancel receives initial focus; Escape cancels an idle decision. The shared confirmation adapter restores focus to its opener, rejects overlapping requests, and cancels on scope change or unmount. Detailed asynchronous confirmation surfaces retain their busy/error handling. No lifecycle operation is executed merely by opening a dialog.

## Notifications

The shared Sonner surface appears at the top center, 56px below the window edge (16px on mobile), with a desktop width of 420px and responsive mobile gutters. Success, information, warning and error states have distinct icons and semantic theme colors. Ordinary notifications retain Sonner's actions and dismissal behavior.

Dashboard-wide operation error/warning banners are absent. Request errors appear as toasts, and repeated Core warnings are announced only when newly observed. An app action failure refreshes app diagnostics without also writing a persistent global error. Persistent app/service diagnostics remain in expanded rows; form validation and unavailable embedded-workspace explanations remain at their point of use.

Error toasts include a scrollable full description, Copy, and a dismiss button. They remain for 20 seconds by default; Sonner pauses expiration during interaction. Copy includes the title, description and known app ID, and reports clipboard failure locally without removing the error. No Undo action is presented for operations that lack undo support.

## Assistant handoff

Ask assistant uses the selected, confirmed assistant's version-1 interface. It is unavailable when the assistant is stopped, incompatible, missing its UI, or the viewer lacks host-administrator access.

An explicit click prepares and finalizes an authenticated handoff containing the diagnostic prompt and known app ID. The toast retains one UUIDv7 request identity for uncertain retries and prevents concurrent duplicate clicks. Long diagnostic text is bounded; Copy retains the full error.

Shell validates the returned endpoint/path against the selected assistant's declared UI, opens its panel and navigates to that conversation. Opening does not submit another prompt. Harness stores a draft by default; its immediate-handoff setting can accept execution instead. Finalization retries preserve the original outcome regardless of later settings changes. See [the handoff contract](../hosty-harness-rename/feature.md).

## Source provenance

The confirmation adapter in `apps/shell/src/components/reui/confirmation.tsx` derives from the free [ReUI c-alert-dialog-5](https://reui.io/r/radix-vega/c-alert-dialog-5.json) composition, with dynamic wording, scope cancellation, and async callers. Its `alert-dialog` dependency is installed from the shadcn Radix registry, as declared by that ReUI example; Hosty's existing Button remains in place. The primitive uses Hosty's `cn` helper and viewport-bounded content.

The rich error/details/actions layout in `apps/shell/src/components/reui/operation-toast.tsx` derives from free [ReUI c-sonner-14](https://reui.io/r/radix-vega/c-sonner-14.json), with the colored feedback pattern from [c-sonner-4](https://reui.io/r/radix-vega/c-sonner-4.json). Hosty adapts the inverse palette to its popover tokens, replaces sample log/retry actions with Copy/Ask assistant, adds a dismiss button and bounded scrolling, and keeps Sonner as the underlying library. The ReUI MIT notice is retained beside these components in `LICENSE`. No Pro block is incorporated.

Shell configures `@reui` as `https://reui.io/r/radix-vega/{name}.json`. The shared upstream Alert Dialog and Separator are local editable dependencies, not a replacement of the whole design system.

## Testing Expectations

- Confirm cancellation, Escape, initial/restored focus, overlapping prompts, and unmount cancellation. Never trigger a real destructive action merely to smoke-test a dialog.
- Verify copy includes full diagnostics; clipboard rejection leaves the error visible. Verify absent/stopped Gateway and concurrent/retried handoff behavior.
- Verify app-context capability negotiation and identical idempotency keys across uncertain session-creation retries.
- Harness tests cover durable drafts, authenticated preparation, complete uploads, unchanged retry outcomes and one execution identity.
- Run Shell tests/lint/build and Gateway tests/web lint/build. Verify the toast position and confirmation cancellation through Core-managed Shell. Retain contextual diagnostics when removing global banners.
