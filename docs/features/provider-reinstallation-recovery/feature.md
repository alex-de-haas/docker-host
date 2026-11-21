---
created: 2026-11-21
updated: 2026-11-21
summary: Harness restores a verified provider context after reinstallation or lets the owner explicitly start a fresh context in the same chat.
components: [apps/harness, apps/codex-provider, packages/agent-provider-runtime]
---

# Recover a Harness chat after provider reinstallation

A chat keeps its transcript, attachments, profile and workspace when its agent provider is reinstalled. Open **Agent settings → Change session context…** to inspect current connections for the same provider application and interface. Select a connection to see its models and reasoning levels. The owner can configure a missing account in the provider application's Shell Settings entry and refresh connections in the open chat. Accepted task attempts keep their assigned connection and model.

## Continue the previous context

Harness matches a saved preference using the provider application, interface, named implementation (when present) and provider-owned account ID. An execution also carries the exact installation and account revision. For an older stored selection ID, Harness looks for a matching qualified selection in the current directory, saved default or retained chat records. A unique current match supplies the logical account. A recreated account gets a new ID even if its name and models match. [Provider connections](../ai-gateway-providers/feature.md)

After a reinstall, an ordinary **Send** by the owner can resume the previous context when the provider verifies it. **Review verified resume** offers the same check while choosing a connection and model manually. Codex Provider checks the retained session and its owner, consumer, account, native thread and outstanding work. It reads the exact thread in the session's private Codex home. Reconnection obtains current Core authority and applies the reviewed configuration before the next turn. An unavailable provider or a failed continuity check leaves the owner free to retry. Only the owner can choose a fresh context. [Agent provider contract](../agent-provider-interface/feature.md#public-http-and-sse-contract)

## Start a fresh context

Select the connection, model and reasoning level, choose **Review fresh start**, then **Start new context**. **Cancel** preserves the selection and composer draft. A fresh start is also available between turns in a healthy chat. The ordinary model and reasoning controls continue to configure the current context.

Confirmation records a visible boundary in the transcript. The next **Send** starts a separate native session with the new message, its attached files, the chat's current configuration, and any authorized resources for that turn. Earlier messages, summaries, prior attachments and tool results stay out of its conversation history. Queued messages pause for review. Earlier unresolved approval and question cards are read-only. If the response to confirmation is lost, reopen the dialog and choose **Retry confirmed change**. The browser reuses the request ID, the original settings revision and the exact reviewed connection.

Harness stores an execution outbox per context. Completed and uncertain runs retain their original identifiers and evidence. Pending local operations or an unconfirmed workspace claim can block the change. The dialog shows the reason from Harness. An installation change alone supplies no evidence of process exit, tool completion or claim release. Owner deletion continues to use the recorded stop evidence for the affected execution. [Workspace sessions](../workspace-sessions/feature.md)

## Testing Expectations

- Run `npm run test:integration -- agent-providers` to exercise both reinstallations in a managed child Core. Set `HOSTY_RECOVERY_BROWSER=1` to cover the confirmation and Cancel in Chromium. The browser helper accepts a Playwright installation through `HOSTY_RECOVERY_PLAYWRIGHT_MODULE`.
- Preserve provider data and reinstall. Check that the installation changes, models resolve for the original account, and an authorized next turn sent through the composer queue resumes the same native thread. Reject foreign owners, changed account identity, missing threads and pending work.
- Reinstall with empty provider data, configure a new account, select a model and cancel once before confirming. Compare the old and new native IDs. Check the first new turn's payload for its message and files and for the absence of earlier conversation, attachment and tool-result markers.
- Exercise a stale settings revision, a second installation or credential change after review, a lost HTTP response, provider downtime and a browser reload. Exact replay produces one context boundary. Keep earlier messages readable and the composer draft intact.
- Check that unresolved workspace claims block the relevant change, ordinary accounts can inspect their current catalogs and accepted tasks keep immutable settings. Deleting an eligible chat preserves siblings and shared source.
