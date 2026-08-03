#!/usr/bin/env bash
set -euo pipefail

# Debug image: same sources, power management compiled out.
#
# The shipping build enables light sleep and frequency scaling, which take the USB-Serial/JTAG
# peripheral down with them — the device drops off the host between a build and a flash. This profile
# keeps it enumerated so the edit/flash/observe loop stops stalling.
#
# It builds into build-debug/ so it never clobbers the release artifacts, and it layers
# sdkconfig.debug over sdkconfig.defaults rather than editing either.
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

Battery figures from this image are meaningless — measure with the release build.
MESSAGE
