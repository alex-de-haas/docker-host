# Scripts

This directory contains repository-level bootstrap scripts.

`scripts/dev-demo-shell.mjs` starts a local Host development session with the current checkout's demo module prelinked as a developer app for shell smoke testing.

The demo shell wrapper configures the data-root environment through Node so the root npm script works across POSIX shells, PowerShell, and cmd.

The Unix installer is `scripts/install.sh`. It stays a thin shell bootstrap:

- download the matching CLI artifact from the rolling `cli-dev` GitHub Release;
- verify `SHA256SUMS` when available and fail clearly if verification cannot be performed;
- install the preferred executable to `~/.hosty/bin/hosty`;
- refresh the deprecated `~/.hosty/bin/docker-host` compatibility alias;
- add the install directory to the user's shell profile when a POSIX-compatible profile can be detected;
- delegate Docker preflight and `launch.env` creation to `hosty install`;
- preserve existing launch configuration on reinstall;
- support `HOSTY_INSTALL_REPO`, `HOSTY_INSTALL_TAG`, `HOSTY_INSTALL_DIR`, `HOSTY_INSTALL_PROFILE`, `HOSTY_INSTALL_SKIP_PATH_UPDATE`, and `HOSTY_INSTALL_START` for forks, tests, custom shells, and explicit start mode;
- continue accepting legacy `DOCKER_HOST_INSTALL_*` variables during migration.

The installer must not duplicate Host lifecycle or module management logic that belongs to the standalone CLI.

The Hosty App Codex skill installer is `scripts/install-hosty-app-skill.sh`. It installs or updates the repository-shipped skill from GitHub into `${CODEX_HOME:-$HOME/.codex}/skills/hosty-app-skill` so agents can use it from other application repositories. It supports `--repo`, `--ref`, `--path`, `--dest`, `--source-dir`, and `--dry-run`.
