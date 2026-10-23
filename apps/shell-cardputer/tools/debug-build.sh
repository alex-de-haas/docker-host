#!/usr/bin/env bash
set -euo pipefail

# Debug image: production behavior with extra logging, built in build-debug/.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "${script_dir}/.." && pwd)"

# Its own sdkconfig, not the project's. SDKCONFIG_DEFAULTS is consulted only when the config file does
# not yet exist, so sharing the root sdkconfig meant these overrides were silently ignored and the
# build produced a release-configured image that merely looked like a debug one.
docker run --rm \
  --volume "${app_dir}:/project" \
  --workdir /project \
  espressif/idf:v5.5.4 \
  idf.py -B build-debug \
    -DSDKCONFIG=/project/build-debug/sdkconfig \
    -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.debug" \
    build

cat <<'MESSAGE'

Debug image built in build-debug/. Flash it with:

  apps/shell-cardputer/tools/debug-flash.sh /dev/cu.usbmodemXXXX

Both images keep the screen and USB active until the physical power switch is used.
MESSAGE
