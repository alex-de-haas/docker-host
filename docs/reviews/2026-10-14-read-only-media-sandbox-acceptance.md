# Read-only Media Server Sandbox Acceptance — 2026-10-14

## Baseline and scope

Core baseline: merged PR #590, `eb9768017de3ec3cfb037c1d6c5e23b4ce13c8aa`, Core 0.132.4 and Harness 0.51.0. Their runtime code is unchanged. Media Server baseline: `16dc206ff86e8ef237b2f21ad33e527b6763952f` plus the registered workspace's read-only catalog/export implementation; manifest version **0.91.3 → 0.92.0**. No commits, PR or release publication are performed in this acceptance.

The non-documentation changed-file fingerprint is `0af19f726179ccb459e2a12cded015905f59c93e7d5e80e67e5001802647dca1`: SHA-256 over sorted changed/untracked paths and each file's SHA-256. Runtime image content IDs below identify the actual tested builds.

This report supersedes the earlier Media acceptance that stopped at the `.incoming` read-only error. The new run completes catalog creation, scan, explicit manual identification, Media UI conversion, provider recovery, export removal and full child/fixture cleanup. It closes sandbox D25 and Media read-only catalog deliverables D1–D4. It does not close the broader permission, aggregate-quota or platform matrix.

## Exact runtime and ownership

A separate coordinator Core at a temporary data root owns Harness. Its real Codex adapter runs in a bounded agent container without a Docker socket; Playwright runs in another container. A scoped transport bridge carries Harness tools. The model itself creates, sets up and finishes the child Core, performs ordinary app install review and signs in with a normal temporary email/password account. Parent users, Git connections and production app data are not inherited.

The first child, `c3256dbc7d994a4ca4fde66edf459961`, exposed a manual-identification original-title lookup that was unnecessary for an in-place read-only file. The implementation fixes that path and adds a regression test; the agent finishes that child before creating the passing child `fab208e7b1604835a0aa8c14a06cb957`. Both children are independently verified removed.

| App service | Version | Actual Docker image content ID |
| --- | --- | --- |
| Media API | 0.92.0 | `sha256:f3852d03b0c78e1ac13103a59e64ada686086d39115de68e2e77c1543740331d` |
| Media web | 0.92.0 | `sha256:7c79481d8d12c0c662863c091678dd7615a5d7769daa408a3a94221d3a918a32` |
| Transcode Engine | 0.13.0 | `sha256:69f9d24ec0d97005cbd93074dd8412c1fc0ed6e183c7326b5698026305ebb402` |

Media images are built from the prepared implementation worktree. The unchanged engine image records source revision `365aa812c4fda3a118a22a45d86fd094de3e5d37`. Fixture recipes preserve real app IDs and service definitions, use exact image aliases with normal Core digest resolution, vendor navigation assets and allocate loopback ports instead of the production fixed Jellyfin port. The existing [recipe helper](../../scripts/experiments/sandbox-core/media-recipes.py) remains useful for installed-image recipes; this source-build run explicitly substitutes its newly built Media images in private recipes. No generated recipes or raw JSON are committed.

The child is created at 17:40:43 UTC; both applications are observed healthy by 17:41:51, about 68 seconds including normal browser installation review. This is an observed setup interval, not an isolated cold-start benchmark.

## Catalog, browser and actual encode

The selected input is `/Users/haas/dev-media`. The child shared-mount library registers it with maximum mode `ro`; both Media API and Transcode Engine receive actual Docker binds with `RW: false`. Unique-file kernel write probes fail with `Read-only file system`, before workload and after engine replacement. The separate fixture-owned `media-output` directory is writable and is bound to Media's new `transcodeOutput` slot and the engine's media slot under the same label.

[Read-only catalog in the authenticated browser](../features/app-sandbox-runtimes/2026-10-14-read-only-media-catalog.png).

The browser creates a read-only catalog (HTTP 201), displays its badge, scans and imports **31 files**. Creation does not create `.incoming`; the selected input is adopted at its original path. An ordinary authenticated manual-match request assigns a temporary explicit test identity, then the real organize/probe/publish pipeline publishes the source with its video/audio tracks. No database seed or authentication bypass is used.

No production TMDb key is copied: automatic metadata lookup/enrichment is not claimed. Torrent Engine remains explicitly missing/unresolved, and torrent ingestion is not tested. Manual test metadata is not evidence of correct external identification.

The conversion dialog offers `Export to media-output`. Through the UI the agent selects H.264, CPU, Small quality, the smallest offered maximum height (480), and the original audio track. The 400-pixel source is not upscaled. A prior conversion POST without an export destination returns **409** with a read-only explanation and leaves the job count at zero.

The entire original AVI is used directly through the read-only bind, not a copied short sample. Source: MPEG-4/MP3, 720×400, 2,858.358 seconds, 444,362,752 bytes. The encode job completes in **399.058 seconds** (6m39s), from the persisted job creation/completion timestamps.

[Completed export controls](../features/app-sandbox-runtimes/2026-10-14-media-export-completed.png).

Independent ffprobe confirms H.264/MP3, **720×400**, **2858.400 seconds**, **219,576,268 bytes**. Full `ffmpeg -v error -i <owned export> -f null -` decode exits zero with no diagnostics. The Activity card shows Done, the export destination and Download/Delete controls. An authenticated one-byte range download returns HTTP 206 with the correct total file size; full payload readability is established by the independent full decode, not by that range request. Library source count stays at one: the export is not added as a library version.

## Dedicated provider recovery

Only Transcode Engine is stopped and started through the child Core API. Stop returns in **3.229 seconds** and start in **1.347 seconds**. A different provider container starts on its assigned endpoint; Media API/web container IDs remain unchanged. Core reports dependency readiness false during the outage and true after recovery. Media's configured-provider `available` flag stays true while tooling capability flags turn false; it is not a liveness flag.

The first export remains downloadable after browser reload. The agent then submits a new remux through Media Server's authenticated browser BFF, with the separate output destination. It completes in **4.604 seconds**, produces 441,168,886 bytes and is independently probed as MPEG-4/MP3, 720×400, 2858.359 seconds. Both jobs show Done and return valid range downloads. Source count and original relative path stay unchanged.

The remux's default null-muxer decode exits zero but reports one duplicate video DTS warning. Decoding the original AVI produces the identical warning at the same timestamp; this is preserved source timing, not a new read-only/export failure. A complete decode with `-fps_mode:v vfr` exits zero with no diagnostics. The H.264 export's default full decode is clean.

## Resource observation

The observer records **453 samples over 2288.35 seconds**, median interval **5.14 seconds**, spanning both attempts, browser operations, encoding, independent decode, recovery and Finish. The table scopes app measurements to the passing child. Worker/browser cgroup lifetime peaks also include earlier fixture activity. Peaks need not occur simultaneously.

| Component | Median working set during encode | Peak Docker working set | Observed cgroup lifetime peak |
| --- | ---: | ---: | ---: |
| Media API | 271.1 MiB | 279.2 MiB | 287.5 MiB |
| Media web | 88.7 MiB | 96.0 MiB | 104.5 MiB |
| Transcode Engine | 189.1 MiB | 196.8 MiB | 922.0 MiB |
| Actual agent worker | 622.1 MiB | 716.2 MiB | 730.1 MiB |
| Separate Playwright browser | 256.4 MiB | 306.4 MiB | 332.5 MiB |

The three app containers peak together at **559.77 MiB**; apps plus agent/browser peak together at **1455.69 MiB (1.42 GiB)** during the passing run. Child Core host RSS peaks at **245.47 MiB** across the fixture; coordinator RSS peaks at **175.62 MiB**. Maximum simultaneous observed host-process RSS is **519.98 MiB**, including Harness launcher/runtime processes.

Docker working set excludes much reclaimable file cache; cgroup charged peaks include cache and temporary decoder load. Host RSS is a separate measurement. These numbers exclude Docker VM overhead, compilers and unrelated host workloads. All observed `oom`/`oom_kill` counters are zero.

Docker reports 16,787,152,896 bytes (15.63 GiB); its setting is not changed. Fixture limits: agent 4 GiB/2 CPU, browser 1.5 GiB/1 CPU, Media API 2 GiB/2 CPU, Media web 1 GiB/2 CPU, engine 2 GiB/2 CPU. App limits are applied after creation, including explicitly to the replaced engine before its next job. They are fixture limits, not shipped admission-time aggregate child quotas. Immediately before Finish, allocated disk is 22,976 KiB for the child root and 667,648 KiB for external outputs. This is one software encode and a small selected library scan, not a 4K/HDR/hardware/concurrency sizing guarantee.

## Removal and source integrity

The agent uses Media Server's Delete export UI (including confirmation) for the first result and its ordinary authenticated deletion API for the second, both with successful removal. The original source record remains until child disposal. Independently, no MKV result remains in the fixture output directory.

The model persists a Finish request UUID, invokes Harness Finish and confirms both children `finished`. Independent checks verify both complete child roots absent, processes exited, all recorded ports closed, container IDs absent, and no child-owned Docker networks/volumes remaining. This fixture uses bind storage; no labeled child networks/volumes existed in the recorded inventory, so this is not a nonempty named-volume cleanup test.

After Finish, a complete rehash compares **118 regular files (94,222,024,758 bytes)** and **154 filesystem entries**. Every SHA-256 matches, as do relative paths, types/modes, sizes, nanosecond modification times and symlink targets. The original media folder is unchanged.

External input/output survive Core Finish by ownership. The coordinator subsequently removes its own empty output folder, agent/browser containers, helper network, parent Core process/root, private sessions and copied provider login, and the seven recorded fixture image aliases. Build image tags/shared Docker layers and both implementation worktrees are retained. No global prune, primary Core restart or primary application lifecycle command is used. Only sanitized Markdown and the two inspected screenshots enter the repository; raw evidence/logs/transcripts remain outside Git.

## Verification

- `dotnet test src/api/MediaServer.sln --no-build --nologo`: **2,237 passed, 0 failed, 0 skipped**, after the final API build and regression fix.
- `pnpm test` in Media web: **199 passed** across 25 files.
- Media API build, production web build and both exact Docker image builds: passed. The migration adds the default-false catalog flag and nullable export label; a historical-schema test fixture now inserts its historical catalog columns explicitly.
- `bash scripts/validate-manifest.sh`: passed at version 0.92.0.
- Documentation index, version consistency where applicable, and `git diff --check`: passed after final documentation updates.
- Real Harness/browser scenario, independent output probes/decodes, provider replacement, filesystem hashes and complete fixture cleanup: passed with the inherited remux timing diagnostic described above.

Core/Harness production code is unchanged; their full suites and NativeAOT publication are not repeated for this Media implementation. Prior baseline Core/environment/dependency/mount checks remain recorded by the feature's earlier acceptance. External TMDb enrichment, torrent ingestion, live-data deployment and the broader sandbox permission/quota/platform matrix are outside this run.
