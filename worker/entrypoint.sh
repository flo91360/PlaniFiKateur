#!/bin/sh
set -eu
# Railway volumes can be mounted as root. Only initialize the worker's directories.
mkdir -p /data/codex
chown node:node /data /data/codex
exec gosu node "$@"
