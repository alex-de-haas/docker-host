# Module Template Notes

This folder is a starting asset for agents creating Docker Host modules.

Before using `metadata.json` in a real module:

- Replace `id`, `name`, `description`, and `version`.
- Replace the image repository, tag, pull policy, and container port.
- Add only settings that the app actually consumes.
- Add only storage paths that the app reads or writes.
- Remove `ui` if the module is service/API-only and should not appear in the Host shell.
- Add module-specific navigation only for same-origin paths served by the module.
- Check the final metadata against `references/module-metadata.md` and the repository validator.
