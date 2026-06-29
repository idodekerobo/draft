#!/bin/bash
# Compatibility wrapper. The Draft CLI owns the complete load lifecycle.

set -u

if command -v draft >/dev/null 2>&1; then
  exec draft load --session-start
fi

if [ -x "$HOME/.draft/bin/draft" ]; then
  exec "$HOME/.draft/bin/draft" load --session-start
fi

# SessionStart must never block agent startup when Draft is not installed.
exit 0
