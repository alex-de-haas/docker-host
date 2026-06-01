# App Template Notes

This folder is a starting asset for agents creating Hosty runtime apps.

Before using `manifest.json` in a real app:

- Replace `id`, `name`, `description`, and `version`.
- Remove `source` when the app has no useful Git repository metadata.
- Replace the image reference, pull policy if needed, and container port.
- Add only settings that the app actually consumes.
- Keep primary persistent state under the `data` directory when Hosty should back it up.
- Use external mount collections only for administrator-selected host folders that Hosty should not back up or delete.
- Remove `ui` if the app is service/API-only and should not appear in Hosty Shell.
- Add app-specific navigation only for same-origin paths served by the app.
- Check the final manifest against `references/app-manifest.md` and the repository validator.
