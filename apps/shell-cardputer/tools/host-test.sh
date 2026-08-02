#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "${script_dir}/.." && pwd)"
build_dir="${app_dir}/build-host"
core_dir="${app_dir}/components/hosty_core"
version="$(tr -d '\r\n' < "${app_dir}/version.txt")"

mkdir -p "${build_dir}"
"${CXX:-c++}" \
  -std=c++20 -Wall -Wextra -Werror -pedantic \
  -DHOSTY_CARDPUTER_VERSION=\"${version}\" \
  -DHOSTY_FIXTURE_DIR=\"${app_dir}/fixtures\" \
  -I"${core_dir}/include" -I"${app_dir}/host" \
  "${core_dir}"/src/*.cpp \
  "${app_dir}/host/ppm_canvas.cpp" \
  "${app_dir}/host/test_main.cpp" \
  -o "${build_dir}/host-tests"

"${build_dir}/host-tests"

