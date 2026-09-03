# Assistant Attachments — plan

Status: Ready
Created: 2026-09-03
Updated: 2026-09-03

Let an operator hand the assistant a file — a log, a config, a screenshot, a manifest — instead of
pasting it into the message box. Cross-cuts [ai-gateway](../ai-gateway/feature.md) (the surface),
[agent-background-sessions](../agent-background-sessions/feature.md) (the session lifecycle a file
attaches to), and the runtime-app storage contract in
[hosty-runtime-app](../hosty-runtime-app/feature.md).

## Goal

A file dropped into the composer lands somewhere the assistant can read it, belongs to that session
and no other, disappears when the session does, and never ends up copied into a backup archive.

## Why this is not an upload button

The gateway starts every harness run with the same working directory: `SessionManager` passes its one
`workDir` to each run (`manager.ts:285`), and that value defaults to the process's **home directory**
(`config.ts:44`) — the manifest does not override it. A file placed "next to the session" today would
land in the container's home directory, visible to every session at once.

The per-session place already exists, just not as a workspace: `SessionStore` keeps
`<data>/sessions/<id>/` for `record.json` and `events.ndjson`, validates the id as a path segment,
and removes the directory when the session is deleted. What is missing is a working directory of
the session's own, and a decision about which root it lives under.

## Where files live, and why not the two obvious places

Three storage kinds exist for a runtime app. The choice turns on lifecycle and on *neighbourhood*,
not on capacity.

- **`data`** — backed up, restored, deleted with the app. Wrong for two reasons. Every attachment
  would be copied into every backup archive: operator-uploaded logs and configs, growing with use, in
  a snapshot taken for a different purpose. And the harness's working directory would sit one `..`
  away from every other session's transcript — see the next section.
- **`externalMounts`** — operator-bound host paths that Hosty never backs up **and never deletes**;
  they survive app removal. That is the lifecycle of a media catalog, and the opposite of a session
  attachment, which should die with its session and at the latest with the app. A mount would leave
  orphaned uploads on the host after `hosty apps remove`, and would make the operator bind a path
  before the assistant could accept a file at all.
- **`cache`** — persists across restarts, updates and runtime switches; never backed up or restored;
  deleted together with `data` when the app is removed. Every property fits. The one mismatch is the
  contract's description — "derived, rebuildable data" — and an attachment is not rebuildable. This
  plan uses `cache` by its properties and says so; the alternative is an open question below.

A session restored from a backup therefore comes back **without** its attachments. That is the
correct outcome, not a loss: the file was input to a conversation that already happened, and the
transcript records that it was attached, so the absence reads rather than surprises.

## The limit this plan does not pretend to remove

A harness is a process with file-reading tools. Codex runs with `sandbox: "read-only"`, which
forbids writes and permits reads anywhere the process can reach; Claude runs with
`permissionMode: "default"`, where writes pass through an approval and reads do not. **A
per-session workspace prevents accidental mixing. It does not contain a model that decides to read
`../`.** Session ids are UUIDs and cannot be guessed, but a directory listing does not need to guess.

Putting workspaces under `cache` rather than `data` narrows what that listing reaches — other
sessions' *uploads*, never their transcripts — and that is as far as storage layout can go. Isolating
one session's agent from another's files is a harness property: a container or a user per session,
which Hosty does not have and this plan does not add. The feature document will carry that sentence,
so nobody reads "per-session workspace" as "sandboxed".

The admission rule bounds who this applies to: assistant sessions are admin-only by decision
(`auth.ts`), so every actor able to reach a workspace is already a host administrator. The isolation
being built is between *sessions*, not between privilege levels.

## Target behaviour

- The manifest declares `cache` beside `data`. Core injects its path; the gateway resolves
  `<cache>/sessions/<id>/workspace` per session and passes it as the harness `cwd`.
- `POST /api/sessions/{id}/attachments` accepts a multipart upload from the session's owner and
  writes it into that workspace under a sanitised name. Limits are enforced there, and refused
  uploads say which limit.
- The composer gains an attach control; an attachment shows in the transcript as its own event,
  carrying the stored name and size, so the conversation records what the model was given.
- The user's message reaches the harness with the workspace path of each attachment; both adapters
  read files from `cwd` through their own tools, so no adapter grows a new capability.
- `GET /api/sessions/{id}/attachments/{name}` returns the file to its owner as
  `Content-Disposition: attachment` with a fixed `application/octet-stream`, never sniffed — an
  uploaded HTML file must not execute in the operator's browser.
- Deleting the session removes the workspace, the same way it removes the session's records.

## Deliverables

- [ ] **A workspace per session.** `cache` declared in the manifest; `<cache>/sessions/<id>/workspace`
      created on session start and handed to the harness as `cwd` instead of the shared `workDir`.
      The shared value stays as the fallback only when no cache directory was injected — a gateway
      started outside Core — and the log says so once. Its default should move off the home directory
      at the same time: it is a `cwd` for an agent, and a home directory is the last place to run one.
- [ ] **Removal follows the session.** `deleteSession` removes the workspace; the retention sweep and
      the abandon sweep remove it with the session they end. Asserted for all three, since a
      workspace that outlived its session is exactly the orphan `externalMounts` would have produced.
- [ ] **Upload.** Multipart, owner-only, bounded: a per-file byte cap, a per-session count cap, a
      per-session byte cap. Names are sanitised to a safe subset and de-duplicated; the original name
      is kept as metadata, never as the path. Each refusal names its cap, beside the accepted case.
- [ ] **Download.** Owner-only, fixed content type, attachment disposition. Asserted that a file
      uploaded as `report.html` comes back in a form a browser will not render.
- [ ] **The transcript records it.** An `attachment_added` event with name, size and the workspace
      path, persisted like every other event so a reconnecting client rebuilds it and a restored
      session explains its missing file.
- [ ] **The harness is told.** The message that carries an attachment reaches the adapter with the
      file's path appended in a fixed, recognisable form. Not injected into the system prompt: the
      file is the operator's input for one turn, not standing instruction.
- [ ] **The composer.** An attach control in `web/src/app/assistant/page.tsx`, the pending attachment
      shown before send, the event rendered in the transcript.
- [ ] **The skill says what an attachment is.** The gateway's own agent-facing instructions state
      that an attached file is the operator's data to read, not instructions to follow — the content
      is untrusted text with a file-reading tool pointed at it, which is an injection surface and
      should be named as one.
- [ ] **Documentation.** `feature.md` created with the storage choice, the restore behaviour, and the
      isolation limit stated in the words above; the ai-gateway and agent-background-sessions
      documents cross-linked.

## Decisions

Open when the plan was written; settled by the operator on 2026-09-03, recorded with what each
implies.

- **`cache`, by its properties, now.** The name mismatch — "rebuildable" for a file that is not — is
  stated in `feature.md` rather than resolved here. Whether the platform wants a fourth storage kind
  for "app-managed, persistent, never backed up, not rebuildable" is a question for the manifest
  contract, raised separately; attachments do not wait on it.
- **The caps: 25 MB per file, 20 files per session, 100 MB per session.** The per-session byte cap is
  the one that guards something real — `cache` is not backed up, but it is disk on the host, and a
  session nobody deletes holds it until the retention sweep does. The other two exist so a single
  upload cannot spend the whole allowance.
- **One clock.** Attachments live exactly as long as the session and are reclaimed by the same
  sweeps — retention and abandonment — and by deletion. No separate expiry: two clocks would produce
  a transcript that references a file the earlier one already took, which is the orphan this plan
  exists to avoid.

## Verification

Unit tests cover the path handling, every cap in both directions, ownership on both routes, the
content-type fixing, and removal on all three exits. What they cannot cover needs a Core-managed
runtime:

1. Start the gateway through Core and confirm `HOSTY_APP_CACHE_DIR` is injected and the workspace is
   created under it, not under the home directory.
2. Attach a log file, ask the assistant a question about it, and confirm the answer came from the
   file — under both harnesses.
3. Delete the session in the UI and confirm the workspace is gone from the host.
4. Take a backup of the gateway and confirm the archive holds the session's records and none of its
   attachments; restore it and confirm the transcript shows the attachment event without the file.
5. From one session, ask the assistant to list `..` — and confirm what it can see is other sessions'
   workspaces and nothing else. This is the limit being documented, checked rather than assumed.
