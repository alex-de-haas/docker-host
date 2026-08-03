#!/usr/bin/env bash
set -euo pipefail

# Flashes the debug image built by debug-build.sh. Takes the serial port as its only argument, because
# the device name differs per host (ls /dev/cu.* on macOS, /dev/ttyACM* on Linux).
if [[ $# -lt 1 ]]; then
  echo "Usage: $(basename "$0") <port>" >&2
  exit 2
fi

port="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "${script_dir}/.." && pwd)"
build="${app_dir}/build-debug"

if [[ ! -f "${build}/hosty_cardputer_shell.bin" ]]; then
  echo "No debug image. Run tools/debug-build.sh first." >&2
  exit 1
fi

# The image is written from the host rather than the container, because USB passthrough is unavailable
# on macOS. esptool is looked for in three places and the script says which one it found — or fails with
# something actionable, rather than a Python import traceback from a module that was never installed.
esptool=""
if command -v esptool.py >/dev/null 2>&1; then
  esptool="esptool.py"
elif python3 -c "import esptool" >/dev/null 2>&1; then
  esptool="python3 -m esptool"
else
  # The ESP-IDF installer puts one in its own environment, which is what tools/install-idf.sh created.
  for candidate in "${HOME}"/.espressif/python_env/*/bin/python; do
    if [[ -x "${candidate}" ]] && "${candidate}" -c "import esptool" >/dev/null 2>&1; then
      esptool="${candidate} -m esptool"
      break
    fi
  done
fi

if [[ -z "${esptool}" ]]; then
  echo "esptool not found. Run tools/install-idf.sh, or pip install esptool." >&2
  exit 1
fi

# shellcheck disable=SC2086
${esptool} --chip esp32s3 --port "${port}" -b 460800 \
  --before default_reset --after hard_reset write_flash \
  --flash_mode dio --flash_size 8MB --flash_freq 80m \
  0x0 "${build}/bootloader/bootloader.bin" \
  0x8000 "${build}/partition_table/partition-table.bin" \
  0xf000 "${build}/ota_data_initial.bin" \
  0x20000 "${build}/hosty_cardputer_shell.bin"
