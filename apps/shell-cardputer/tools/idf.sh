#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "${script_dir}/.." && pwd)"
bundled_idf="${app_dir}/.tools/esp-idf"

if [[ -n "${IDF_PATH:-}" && -f "${IDF_PATH}/export.sh" ]]; then
  source "${IDF_PATH}/export.sh"
elif [[ -f "${bundled_idf}/export.sh" ]]; then
  source "${bundled_idf}/export.sh"
else
  echo "ESP-IDF v5.5.4 is not installed. Run tools/install-idf.sh first." >&2
  exit 2
fi

cd "${app_dir}"
exec idf.py "$@"

