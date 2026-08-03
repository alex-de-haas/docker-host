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

# esptool from the bundled ESP-IDF's Python environment, so this needs no global install. The image is
# written from the host rather than the container because USB passthrough is unavailable on macOS.
python="$(command -v esptool.py || true)"
if [[ -n "${python}" ]]; then
  esptool="esptool.py"
else
  esptool="python3 -m esptool"
fi

# shellcheck disable=SC2086
${esptool} --chip esp32s3 --port "${port}" -b 460800 \
  --before default_reset --after hard_reset write_flash \
  --flash_mode dio --flash_size 8MB --flash_freq 80m \
  0x0 "${build}/bootloader/bootloader.bin" \
  0x8000 "${build}/partition_table/partition-table.bin" \
  0xf000 "${build}/ota_data_initial.bin" \
  0x20000 "${build}/hosty_cardputer_shell.bin"
