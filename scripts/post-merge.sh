#!/bin/bash
set -e

# Keep the workspace dependency tree in sync after isolated task changes.
# The running workflow rebuilds the application during reconciliation.
npm install --no-audit --no-fund --ignore-scripts