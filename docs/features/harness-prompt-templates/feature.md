---
created: 2026-11-11
updated: 2026-11-11
summary: Personal prompt templates saved in Harness settings and inserted literally into a conversation draft using shortcuts or the Add menu.
components: [apps/harness]
---

# Harness Prompt Templates

Harness administrators save personal reusable prompts in **Settings → Prompt templates** at
`/settings/templates`. Each template has a title, a shortcut and multiline prompt text. Create,
edit and delete actions retain field errors and unsaved edits. The library belongs to the signed-in
user and persists in Harness app data across browser reloads and devices; it is separate from
shared agent profiles and common instructions.

## Inserting Templates

In the shared conversation composer, typing `!` at a word boundary opens the template picker.
The remaining text, such as `!pr`, filters by shortcut or title without regard to letter case.
The **+ → Prompt template** action opens the same picker with a search field. A settings link
and empty, loading, error and retry states remain available in the picker.

Arrow keys move the active choice. Enter or Tab selects a matching template; Escape closes the
picker and keeps the literal shortcut. Enter while the shortcut picker is open never sends a
message, including when loading, empty or unavailable. Shift+Enter and IME composition retain
their editing behavior. Shortcut detection ignores inline and fenced code and shortcuts embedded
inside another word.

A shortcut selection replaces only the typed range. The Add menu inserts at the retained caret
or replaces the selected text. Other draft text, attachments and untouched app-mention identities
remain in place. Insertion focuses the editor, places the caret after the text and participates
in its undo/redo history. Template bodies are literal text; `@` lookalikes do not acquire app-context
metadata. Inserting a template does not send it. The same editor serves ordinary, workspace and
embedded conversations and unlocked queued-message edits.

## Storage And Concurrency

The authenticated administrator's app session accesses `GET` and `PUT`
`/api/preferences/prompt-templates`. Responses use `Cache-Control: no-store`, cookie writes require
same-origin proof, and delegated clients cannot access this personal API. Ownership comes from
the authenticated actor rather than request fields. Users can reuse shortcuts or template IDs
without sharing a library.

The collection permits up to 100 templates. Titles are nonblank, at most 120 characters and
contain no control characters. Shortcuts use 1–40 ASCII letters, numbers, underscores or hyphens,
begin with a letter or number and are unique without regard to case. Prompt text is nonblank and
at most 16,000 UTF-16 code units; significant whitespace is preserved. The persisted library and
incoming JSON are bounded to 512 KiB.

Per-user writes are serialized and replace the file atomically. Each save carries the displayed
revision and a UUID. A stale revision returns a conflict, and **Reload saved templates** refreshes
the collection while preserving the local form. An uncertain result retains the exact input and
UUID and blocks further mutations until Retry resolves it. The last 32 receipts persist with the
library; exact replay returns the latest collection without applying the earlier write again.
Reusing an operation UUID with different input returns a conflict. A damaged stored file surfaces
an error instead of silently resetting the user's templates.

## Verification

Windows verification passed: 104 affected unit/component tests with `NODE_ENV=test`,
`npm run harness:lint`, `npm run harness:build-web`, version consistency and documentation checks.
Edge also verified normal password login through the isolated child Core URL.

The operator selected **Leave the implementation without browser verification** in Decision
`aa0a1ebb-9c43-40c7-a602-d85b2feda049` on 2026-11-11. Harness app browser acceptance and runtime
integration checks were not run: its test installation was not approved or applied. This is an
explicit acceptance waiver, not a successful app runtime check. The child Core is finished, with
no process or active consumers; the registered source worktree remains available.

## Testing Expectations

- Store and HTTP tests cover persistence, validation and limits, parallel revision conflicts,
  durable exact replay, user isolation, authentication, origin protection and uncached reads.
- Settings tests cover CRUD, duplicate shortcuts, field errors, retained edits, conflict reload,
  unknown-result retries and independent loading from shared settings.
- Editor tests cover literal multiline Unicode, replacement ranges, mention identity preservation,
  caret placement, undo/redo, keyboard priority, IME, unknown aliases, code boundaries and stale
  picker responses. Existing queue, composer and prompt-suggestion regressions remain covered.
- Runtime verification, when selected, uses a separate Core-managed child with synthetic data,
  normal password login and its advertised Core/app URLs. Report unrun runtime checks separately
  from unit/component coverage and retain explicit operator acceptance waivers.
