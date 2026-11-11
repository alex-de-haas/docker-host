---
status: In Progress
created: 2026-11-11
updated: 2026-11-11
summary: Personal prompt templates with configurable shortcuts, settings and insertion into the shared Harness composer.
components: [apps/harness]
---

# Harness Prompt Templates

## Goal

Let an operator save reusable prompts and insert them into the message field by a short alias,
such as `!pr`. The inserted prompt remains editable until the operator sends it.

## Proposed Behavior

- Add a personal **Prompt templates** settings page with create, edit and delete actions. Each
  template has a title, a unique case-insensitive shortcut and a multiline plain-text body.
  Show validation errors beside the fields and preserve unsaved text after a failed save.
- Use `!` as the initial shortcut prefix. Typing `!` at a word boundary opens a searchable picker;
  typing `!pr` filters by shortcut and title. A **Prompt template** item in the existing **+**
  menu opens the same picker without requiring the operator to remember an alias. Include a
  link to template settings and explain the empty state.
- Arrow keys move the active choice. Enter or Tab chooses a matching template; Escape dismisses
  the picker. While the shortcut picker is visible, Enter never sends a message. Shift+Enter
  retains multiline editing, and IME composition keeps its existing behavior.
- Selection replaces only the shortcut at the caret. Opening from **+** inserts at the saved
  caret position or replaces the selected text. Preserve surrounding text, existing app mentions,
  attachments and undo/redo. Put the caret after the inserted text and focus the editor.
- Shortcut recognition requires a collapsed selection outside inline or fenced code and never
  triggers inside another word. Unknown aliases remain literal text. Templates are inserted
  verbatim: their contents are not interpreted as commands, variables or app-context selections.
- Support the shared conversation composer in ordinary chats, workspaces and embedded assistant
  panels, including editable queued messages. Existing edit locks and sending rules still apply.
- Store templates durably in Harness, scoped to the authenticated user rather than browser,
  conversation or shared agent profile. Another user cannot read or change them. Use bounded
  fields and collection size, serialized writes, atomic replacement and revision conflict checks.
  Reload on a conflict without discarding the local edit; reconcile an uncertain save before retry.

## Implementation Locations

- Add a personal template store and authenticated API near the existing personal
  `sessions/suggestion-preferences.ts` pattern. Keep it separate from shared `SettingsStore` and
  agent profiles. Derive ownership from the authenticated actor; apply the existing origin checks.
- Add the settings page and navigation under `web/src/app/settings` and
  `web/src/components/gateway-settings.tsx`, with a small template API client.
- Extend the editing integration around `web/src/components/app-mention-input.tsx` and
  `assistant-conversation.tsx`. Reuse its mention-aware draft/undo machinery and accessible picker
  primitives; coordinate keyboard handling with app mentions and transcript prompt suggestions.
- Update the owning composer documentation and create `feature.md` when behavior is implemented.
  Regenerate the documentation index. Bump Harness from `0.96.4` to `0.97.0` in its manifest and
  both package files, and update lockfile metadata when required by the repository checks.

## Deliverables

- [x] D1. Persist and validate personal templates through an authenticated API, with tests for
  user isolation, missing authentication, origin protection, invalid input, reload persistence,
  revision conflicts and uncertain-save recovery.
- [x] D2. Provide template settings with create, edit, delete, empty, loading and error states;
  verify duplicate aliases and retained unsaved edits.
- [x] D3. Insert templates through shortcut search and the existing Add menu in every shared
  conversation composer, preserving drafts, mentions, attachments, queued edits and undo/redo;
  cover keyboard priority, no automatic sending, IME and code/word boundaries.
- [ ] D4. Run affected tests, Harness lint and web build; verify settings and insertion in a
  Core-managed child using synthetic data and normal password login; complete feature docs,
  version consistency and documentation checks, and report the actual verification results.

## Verification

- Run affected backend, store, parser and React component Vitest suites through the Harness test
  script. Include an inserted template containing multiline Unicode text and literal `@` or `/`
  text without granting it app-context metadata or sending it.
- Run `npm run harness:lint`, `npm run harness:build-web`, `node scripts/check-versions.mjs`
  and `node scripts/docs-index.mjs --check` after the final edits.
- Use one Core-managed child with separate users and app data for browser/API verification.
  Check normal password login, anonymous denial, per-user template isolation, persisted CRUD,
  pointer and keyboard insertion, populated drafts, narrow panes and the Core preview URL.
  Export verification results before finishing the child through supported lifecycle tools.
- Commits, publication and changes to the operator's live runtime require their corresponding
  authorization and are outside this implementation approval.

## Verification Results

- Windows: 104 affected unit/component tests passed with `NODE_ENV=test`; Harness lint, web
  production build and version consistency checks passed. The host defaults to production, so
  React component tests explicitly use the test environment.
- Normal password login through the child Core's advertised URL passed in Edge with no page
  errors. App browser verification awaits Core's installation permission review in the same child.
- The earlier broad gateway run included unrelated fixture/task-API and Windows rename failures;
  the bounded affected suites passed. No provider secrets or live app data are used.

## Approval Record

The operator approved this plan with the `!pr` prefix in Decision
`0d7a672f-0384-4b91-b996-76377631ddfd` on 2026-11-11. Implementation is authorized;
commits, publication and live runtime changes retain their separate authorization requirements.
