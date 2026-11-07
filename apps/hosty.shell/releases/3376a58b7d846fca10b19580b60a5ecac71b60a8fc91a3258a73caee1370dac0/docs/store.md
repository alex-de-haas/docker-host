![Hosty Shell](../assets/icon.svg)

# Hosty Shell

The browser UI for a Hosty host. It is the surface where apps are installed,
configured, updated, and removed — everything the CLI can do to a host, with the
review steps made visible.

## What it gives you

- **Installed Apps** — one inventory with lifecycle controls, per-app settings,
  logs, backups, and reviewed updates. Removal opens a confirmation that names
  what else depends on the app before anything happens.
- **Reviewed installs and updates** — every install and update is a plan you read
  first: the version change, the runtime, the manifest digest, the settings, and
  any escalation the manifest asks for.
- **Marketplace** — browse a catalog and hand an app's feed to the install flow.
  The storefront installs nothing itself; Core fetches and validates the feed.
- **Users and access** — host administrators manage accounts and decide which
  apps an ordinary user can see and open.
- **Platform settings** — Core's own behavior settings and one-click Cloudflare
  ingress for publishing an origin.

## Good to know

The Shell is an ordinary runtime app that happens to serve the UI. It can be
updated and uninstalled like any other app — including from inside itself, which
the remove panel warns about. The host and its apps keep running without it, and
it comes back with:

```bash
hosty setup --with hosty.shell
```

Only host administrators can open it; it stays hidden from ordinary users.
