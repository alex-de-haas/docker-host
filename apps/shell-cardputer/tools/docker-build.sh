#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "${script_dir}/.." && pwd)"

docker run --rm \
  --volume "${app_dir}:/project" \
  --workdir /project \
  espressif/idf:v5.5.4 \
  idf.py build
