#!/usr/bin/env bash
cd "$(dirname "$0")"
exec node ingest.js --watch
