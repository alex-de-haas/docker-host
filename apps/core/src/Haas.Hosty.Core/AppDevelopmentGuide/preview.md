# Child Core preview

Create an authorized environment with environment_create, retaining its requestId; use the
workspace/worktree reference returned by prepare or app_create. A registered worktree has both
`id` (the worktree) and `workspaceId` (the aggregate workspace). For environment_create use
`workspaceId: worktree.workspaceId` and `worktreeIds: [worktree.id]`; these IDs are not interchangeable. Source/Git tools and app_local_status instead take the worktree
`id` in their `workspaceId` argument.
Start it with environment_start using the observed revision. Obtain consent through environment_consent if required; a denial is final
until the operator explicitly changes it. Do not switch routes to evade it.

Use environment_setup with normal email/password setup and environment_api for child Core
requests. Credentials belong only to this disposable environment: do not copy parent accounts,
tokens, connections, application data or production dependencies. The Core itself is trusted
and may manage Docker. Agent and application containers are separate.

Inspect the child API and install the worktree manifest with the dev Docker profile. App install,
manifest permission review and app start remain ordinary child Core actions. The parent app
stays stopped. Read the child apps API and the workspace preview panel for observed service state and preview URLs.
Operator browser access uses normal child Core login; API authentication is not browser login.
Keep the same environment and its test data between iterations. Finish deletes child resources,
not canonical source. Do not Finish a preview requested for operator review.

### Child API recipe

Do not probe `/api` for discovery; it is not a route index. `environment_api` accepts the following
ordinary child API requests after setup:

1. `GET /api/apps` lists installations, runtime state and URLs. If the app already exists, inspect it
   and reuse it instead of reinstalling blindly.
2. `POST /api/installations` with `{ "manifestPath": "<worktree>/manifest.json", "selectedRuntime": "dev" }`
   prepares a reviewed installation. Use the actual manifest-relative path from the workspace.
3. `POST /api/installations/<id>/submit` with `{ "autostart": false }` submits it. Show the returned
   `approvalUrl` to the operator and wait for its decision. `GET /api/installations/<id>` reports the
   outcome. A permission refusal must not be retried through a different authority.
4. After approval, `POST /api/apps/<app-id>/start` with `{}` starts the Docker runtime.
   `GET /api/apps` supplies the resulting UI URL and runtime observations.
5. `POST /api/apps/<app-id>/restart` with `{}` applies an explicit restart when required.

For an installed app whose services, images/build revision, mounts or permissions changed,
repeat steps 2–3 with `"updateAppId": "<app-id>"` added to the installation request. Review
the complete new manifest, not a second installation. The update keeps the installation and
data directory, stops the old services and restarts a previously running app. If it was stopped,
start it explicitly. Core removes obsolete service containers on start; data and caches remain
until Finish. Keep the data target's container path stable when moving it to a replacement service.
Use `dependsOn` and `HOSTY_SERVICE_<KEY>_URL` for private sibling services. Check each service's
observed health and the refreshed preview link; a successful review is not proof of readiness.

`POST /api/apps/install` is not an approval shortcut: it returns `approval_required`.
An authorized local operator can also review/apply an install through the child's normal CLI/control
API; the agent container has no child control secret or host Docker socket. Runtime diagnostics and
application HTTP tests must use actual advertised origins and normal child authentication.
A source-launched parent may have no installed release binary: use the reviewed `current` mode or
ask the operator to install the release before requesting `release`; never change the target after a denial.

From the shared Docker worker, a `*.hosty.localhost` name resolves to that container's loopback,
not the Core host. For a local HTTP probe, connect to `host.docker.internal:<observed-port>` and
preserve the preview's original `Host` header (and original `Origin` on POST). Use only the actual
advertised port; this routing change does not replace app credentials or authorize another app.
The browser uses the original advertised URL. Probe the client bundle as well as `/healthz`:
a healthy process alone does not prove the generated page can build or authenticate.


## One sandbox model

Every sandbox is a child Core with ordinary applications. Use environment_create and the existing
consent/start/setup/environment_api tools; no separate app-sandbox allocator, persona auth, reset
API or private browser worker exists. Install one or several apps through normal child APIs and
review their permissions/dependencies. Browser checks use the advertised Core/app origins and
normal password login with child-only test accounts. Stop/Restart retains data. Finish followed by
a new environment is a fresh test; keep useful reports outside the child-owned root.

Current/release copy the selected Core executable closure; source builds an explicitly selected
registered Core project. An app workspace does not imply a source Core. Observe the actual child
version: a continuing child survives a parent update on its private copy, while parent Start/Restart
prepares its existing selected input. Do not replace this behavior with automatic synchronization.

