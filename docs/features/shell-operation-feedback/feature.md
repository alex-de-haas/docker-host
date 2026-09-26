Created: 2026-09-25
Updated: 2026-09-25

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

Ask assistant is absent when Shell cannot discover an installed `ai-gateway` interface. When installed, the action is disabled if the Gateway is stopped, the panel is missing, or the user lacks host-administrator access. Runtime/provider availability is rechecked when invoked.

An explicit click creates a new Gateway session through the existing authenticated delegated client. Known app IDs become session context when the selected harness supports app context; otherwise the diagnostic provenance still names the app. Session creation uses an actor-scoped idempotency key, reused after an uncertain response and for retries from the same toast. Concurrent clicks on that toast do not create multiple requests.

Shell selects the assistant panel and sends `hosty:open-assistant-session` with the session ID, optional draft and source app ID. Gateway accepts messages only from its parent window, loads the session through its authenticated API, and fills an empty draft with provenance. It preserves an existing draft, ignores stale session lookups, and never sends a message. Long diagnostic drafts are explicitly truncated to the handoff limit; Copy retains the full error. App context remains subject to Gateway's normal authorization and availability checks.

## Source provenance

The confirmation adapter in `apps/shell/src/components/reui/confirmation.tsx` derives from the free [ReUI c-alert-dialog-5](https://reui.io/r/radix-vega/c-alert-dialog-5.json) composition, with dynamic wording, scope cancellation, and async callers. Its `alert-dialog` dependency is installed from the shadcn Radix registry, as declared by that ReUI example; Hosty's existing Button remains in place. The primitive uses Hosty's `cn` helper and viewport-bounded content.

The rich error/details/actions layout in `apps/shell/src/components/reui/operation-toast.tsx` derives from free [ReUI c-sonner-14](https://reui.io/r/radix-vega/c-sonner-14.json), with the colored feedback pattern from [c-sonner-4](https://reui.io/r/radix-vega/c-sonner-4.json). Hosty adapts the inverse palette to its popover tokens, replaces sample log/retry actions with Copy/Ask assistant, adds a dismiss button and bounded scrolling, and keeps Sonner as the underlying library. The ReUI MIT notice is retained beside these components in `LICENSE`. No Pro block is incorporated.

Shell configures `@reui` as `https://reui.io/r/radix-vega/{name}.json`. The shared upstream Alert Dialog and Separator are local editable dependencies, not a replacement of the whole design system.

## Testing Expectations

- Confirm cancellation, Escape, initial/restored focus, overlapping prompts, and unmount cancellation. Never trigger a real destructive action merely to smoke-test a dialog.
- Verify copy includes full diagnostics; clipboard rejection leaves the error visible. Verify absent/stopped Gateway and concurrent/retried handoff behavior.
- Verify app-context capability negotiation and identical idempotency keys across uncertain session-creation retries.
- Gateway tests cover fresh-session draft delivery, preservation of old and edited drafts, rejection of messages from another frame, and no automatic send.
- Run Shell tests/lint/build and Gateway tests/web lint/build. Verify the toast position and confirmation cancellation through Core-managed Shell. Retain contextual diagnostics when removing global banners.
