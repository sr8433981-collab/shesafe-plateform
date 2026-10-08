#!/usr/bin/env bash
# ============================================================================
#  SheSafe - cross-platform launcher (macOS / Linux)
#
#  Creates a virtualenv on first run, installs dependencies, starts the Flask
#  API and opens the browser.
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

VENV=".venv"
PYTHON_BIN="${PYTHON_BIN:-python3}"

blue()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
red()   { printf '\033[1;31m%s\033[0m\n' "$*"; }

blue "======================================================"
blue "  SheSafe - Personal Safety & Emergency Response"
blue "======================================================"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  red "[ERROR] Python 3.10+ was not found."
  echo "  Install Python, or set PYTHON_BIN to its path."
  exit 1
fi

if [ ! -d "$VENV" ]; then
  blue "[1/3] Creating virtual environment..."
  "$PYTHON_BIN" -m venv "$VENV"
fi

# shellcheck disable=SC1091
source "$VENV/bin/activate"

blue "[2/3] Installing dependencies..."
pip install --quiet --upgrade pip
pip install --quiet -r backend/requirements.txt

PORT="${PORT:-5000}"
blue "[3/3] Starting SheSafe on http://localhost:${PORT}"
echo "     Demo mode: ${SHESAFE_DEMO_MODE:-0}   (set SHESAFE_DEMO_MODE=1 to enable)"
echo "     In an emergency, call 112."
echo

( sleep 2
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:${PORT}" || true
  elif command -v open >/dev/null 2>&1; then open "http://localhost:${PORT}" || true
  fi ) &

exec python backend/wsgi.py