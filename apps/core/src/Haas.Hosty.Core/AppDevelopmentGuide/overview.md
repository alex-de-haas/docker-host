# Hosty app development

This guide is packaged with the running Core. Each response identifies its Core version, content
revision, manifest schema, selected topic and complete topic index. Read one topic at a time;
there is no all-topics expansion or arbitrary file reader. Refresh after a Core upgrade.

Read `source` before editing, `docker` for runtime structure, `identity` and `sdk` before adapting
a stack, `preview` to run it, and `checks` and `finish` before reporting completion. The default
Node/React bootstrap is a starting point, not a required stack. Plans are optional; follow the
operator's editable workflow instructions without treating them as permission to publish or delete.

The normal flow is local Git → registered worktree → child Core → Docker preview → checks and
operator review → authorized commit → Accept locally → optional Use locally or remote publication.
The parent application stays stopped until ordinary use is explicitly requested. Agent and app
containers are separate. Preview data/users are disposable; canonical source is durable.

Readers:
- Harness development MCP: `app_creation_guide` with optional `{ "topic": "identity" }`.
- Direct Core MCP: `get_app_development_guide` with the same optional topic.
- Operator CLI: `hosty --data-root <root> apps guide --topic identity --format json` (or `text`).
- Authorized control client: `GET /control/v1/apps/development-guide?topic=identity`.

MCP needs its existing reviewed authority. If MCP is disabled or refused, do not circumvent the
decision with a shell command, another credential or a broad CLI bridge. An already authorized typed
coordinator/control reader may retrieve the same content. Guide access itself grants no mutations.
