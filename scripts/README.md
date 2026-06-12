# Scripts

This directory contains repository-level bootstrap scripts.

The Unix installer is `scripts/install.sh`. It stays a thin shell bootstrap:

- download the matching CLI artifact from the rolling `cli-dev` GitHub Release;
- verify `SHA256SUMS` when available and fail clearly if verification cannot be performed;
- install the preferred executable to `~/.hosty/bin/hosty`;
- add the install directory to the user's shell profile when a POSIX-compatible profile can be detected;
- delegate Docker preflight and `launch.env` creation to `hosty install`;
- leave Core executable installation to `hosty start`, which downloads Core only when `~/.hosty/core/bin/hosty-core` is missing;
- let Core bootstrap Shell from the `HOSTY_SHELL_MANIFEST_PATH` and `HOSTY_SHELL_BOOTSTRAP_RUNTIME` values stored in `launch.env`;
- preserve existing launch configuration on reinstall;
- support `HOSTY_INSTALL_REPO`, `HOSTY_INSTALL_TAG`, `HOSTY_INSTALL_DIR`, `HOSTY_INSTALL_PROFILE`, `HOSTY_INSTALL_SKIP_PATH_UPDATE`, and `HOSTY_INSTALL_START` for forks, tests, custom shells, and explicit start mode.

The Windows installer is `scripts/install.ps1`. It follows the same bootstrap boundary:

- download `hosty-windows-x64.exe` from the rolling `cli-dev` GitHub Release;
- verify `SHA256SUMS` when available and fail clearly on checksum mismatch;
- install the executable to `%USERPROFILE%\.hosty\bin\hosty.exe` unless `HOSTY_INSTALL_DIR` is set;
- add the install directory to the current user's PATH unless `HOSTY_INSTALL_SKIP_PATH_UPDATE=1`;
- delegate local directory preparation to `hosty install`;
- leave Core executable installation to `hosty start`, which downloads Core only when `%USERPROFILE%\.hosty\core\bin\hosty-core.exe` is missing;
- support `HOSTY_INSTALL_REPO`, `HOSTY_INSTALL_TAG`, `HOSTY_INSTALL_DIR`, `HOSTY_INSTALL_SKIP_PATH_UPDATE`, and `HOSTY_INSTALL_START`.

The installer must not duplicate Core lifecycle or app management logic that belongs to the standalone CLI.

The Hosty App Codex skill installer is `scripts/install-hosty-app-skill.sh`. It installs or updates the repository-shipped skill from GitHub into `${CODEX_HOME:-$HOME/.codex}/skills/hosty-app-skill` so agents can use it from other application repositories. It supports `--repo`, `--ref`, `--path`, `--dest`, `--source-dir`, and `--dry-run`.
