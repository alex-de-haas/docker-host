# Scripts

This directory contains repository-level bootstrap scripts.

`scripts/dev-demo-shell.mjs` starts a local Host development session with the current checkout's demo module prelinked as a developer app for shell smoke testing.

The demo shell wrapper configures the data-root environment through Node so the root npm script works across POSIX shells, PowerShell, and cmd.

The Unix installer is `scripts/install.sh`. It stays a thin shell bootstrap:

- download the matching `docker-host` CLI artifact from the rolling `cli-dev` GitHub Release;
- verify `SHA256SUMS` when available and fail clearly if verification cannot be performed;
- install the executable to `~/.docker-host/bin/docker-host`;
- add the install directory to the user's shell profile when a POSIX-compatible profile can be detected;
- delegate Docker preflight and `launch.env` creation to `docker-host install`;
- preserve existing launch configuration on reinstall;
- support `DOCKER_HOST_INSTALL_REPO`, `DOCKER_HOST_INSTALL_TAG`, `DOCKER_HOST_INSTALL_DIR`, `DOCKER_HOST_INSTALL_PROFILE`, `DOCKER_HOST_INSTALL_SKIP_PATH_UPDATE`, and `DOCKER_HOST_INSTALL_START` for forks, tests, custom shells, and explicit start mode.

The installer must not duplicate Host lifecycle or module management logic that belongs to the standalone CLI.

The Docker Host Module Codex skill installer is `scripts/install-docker-host-module-skill.sh`. It installs or updates the repository-shipped skill from GitHub into `${CODEX_HOME:-$HOME/.codex}/skills/docker-host-module` so agents can use it from other application repositories. It supports `--repo`, `--ref`, `--path`, `--dest`, `--source-dir`, and `--dry-run`.
