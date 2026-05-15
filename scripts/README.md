# Scripts

This directory contains repository-level bootstrap scripts.

The Unix installer is `scripts/install.sh`. It belongs to Phase 10 and stays a thin shell bootstrap:

- download the matching `docker-host` CLI artifact from the rolling `cli-dev` GitHub Release;
- verify `SHA256SUMS` when available and fail clearly if verification cannot be performed;
- install the executable to `~/.docker-host/bin/docker-host`;
- delegate Docker preflight and `launch.env` creation to `docker-host install`;
- preserve existing launch configuration on reinstall;
- support `DOCKER_HOST_INSTALL_REPO`, `DOCKER_HOST_INSTALL_TAG`, `DOCKER_HOST_INSTALL_DIR`, and `DOCKER_HOST_INSTALL_START` for forks, tests, and explicit start mode.

The installer must not duplicate Host lifecycle or module management logic that belongs to the standalone CLI.
