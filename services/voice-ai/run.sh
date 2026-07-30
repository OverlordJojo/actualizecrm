#!/usr/bin/env bash
# Starts the local voice sidecar. Creates the venv on first run.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "Creating virtualenv..."
  python3 -m venv .venv
  ./.venv/bin/pip install --upgrade pip
  ./.venv/bin/pip install -r requirements.txt
fi

if ! curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
  echo "WARNING: Ollama is not responding on :11434. Extraction will fail."
  echo "  Start it with: ollama serve"
fi

exec ./.venv/bin/python server.py
