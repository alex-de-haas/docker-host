#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "${script_dir}/.." && pwd)"
build_dir="${app_dir}/build-host"
core_dir="${app_dir}/components/hosty_core"
version="$(tr -d '\r\n' < "${app_dir}/version.txt")"

mkdir -p "${build_dir}/render"
"${CXX:-c++}" \
  -std=c++20 -Wall -Wextra -Werror -pedantic \
  -DHOSTY_CARDPUTER_VERSION=\"${version}\" \
  -I"${core_dir}/include" -I"${app_dir}/host" \
  "${core_dir}"/src/*.cpp \
  "${app_dir}/host/ppm_canvas.cpp" \
  "${app_dir}/host/render_harness.cpp" \
  -o "${build_dir}/render-harness"

"${build_dir}/render-harness" "${build_dir}/render"

