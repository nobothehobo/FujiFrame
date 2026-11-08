#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo 'Python 3.11 or newer is required. Install it from https://www.python.org/downloads/'
  exit 1
fi
if [ ! -x .venv-studio/bin/python ]; then
  python3 -m venv .venv-studio
  .venv-studio/bin/python -m pip install -r studio/requirements.txt
fi
exec .venv-studio/bin/python -m studio "$@"
