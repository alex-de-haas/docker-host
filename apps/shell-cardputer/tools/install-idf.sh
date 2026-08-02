#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "${script_dir}/.." && pwd)"
tool_dir="${app_dir}/.tools/esp-idf"

if [[ ! -d "${tool_dir}/.git" ]]; then
  mkdir -p "${app_dir}/.tools"
  git clone --branch v5.5.4 --depth 1 --recursive https://github.com/espressif/esp-idf.git "${tool_dir}"
fi

"${tool_dir}/install.sh" esp32s3

