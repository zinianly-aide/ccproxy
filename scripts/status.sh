#!/usr/bin/env bash
set -euo pipefail

launchctl list | grep lanai || true
