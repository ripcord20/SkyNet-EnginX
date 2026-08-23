#!/usr/bin/env bash
# Idempotent Cloud Agent install: refresh Node dependencies for the nested app.
# Does not start servers, run migrations, or require a database.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${ROOT}/SkyNet-EnginX"

if [[ ! -f "${APP_DIR}/package.json" ]]; then
  echo "error: expected ${APP_DIR}/package.json" >&2
  exit 1
fi

cd "${APP_DIR}"

# This repository gitignores lockfiles, so prefer npm ci only when one exists.
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

echo "SkyNet-EnginX dependencies installed."
