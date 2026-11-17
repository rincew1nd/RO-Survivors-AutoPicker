#!/usr/bin/env bash
# Isolated CloakBrowser launch: own profile, unpacked addon, game URL.
# CloakBrowser is required; the addon is developed against that build.
# Real Chrome/Edge settings are not touched.
# --silent-debugger-extension-api hides the "started debugging this
# browser" bar that the addon's trusted key replay would otherwise show.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ext="$here/src"
# Linux keeps its own profile: the Windows launcher uses .cloak-profile,
# and a Chrome profile must not be shared between the two platforms.
profile="${RO_PROFILE:-$here/.cloak-profile-linux}"
url="https://ro-survivors.com/"

browser="${CLOAKBROWSER_BINARY_PATH:-}"
if [ -z "$browser" ]; then
  browser="$(ls -1d "$HOME"/.cloakbrowser/chromium-*/chrome 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -z "$browser" ] || [ ! -x "$browser" ]; then
  echo "CloakBrowser binary not found in \"$HOME/.cloakbrowser\"." >&2
  echo "Run: npx -y cloakbrowser install" >&2
  exit 1
fi

mkdir -p "$profile"

# Ubuntu 23.10 and later restrict unprivileged user namespaces, and the
# CloakBrowser build has no setuid sandbox helper, so it refuses to start.
# Fall back to --no-sandbox there; RO_SANDBOX=1 keeps the sandbox.
extra=()
restrict_userns="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)"
browser_dir="$(dirname -- "$browser")"
if [ "$restrict_userns" = "1" ] && [ ! -u "$browser_dir/chrome_sandbox" ]; then
  extra+=(--no-sandbox)
  echo "warning: unprivileged user namespaces are restricted here;" >&2
  echo "warning: starting with --no-sandbox (set RO_SANDBOX=1 to keep it)." >&2
fi
if [ "${RO_SANDBOX:-0}" = "1" ]; then
  extra=()
fi

exec "$browser" \
  --user-data-dir="$profile" \
  --load-extension="$ext" \
  --disable-extensions-except="$ext" \
  --ignore-gpu-blocklist \
  --start-maximized \
  --no-first-run \
  --no-default-browser-check \
  --disable-backgrounding-occluded-windows \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --disable-features=IntensiveWakeUpThrottling \
  --silent-debugger-extension-api \
  "${extra[@]}" \
  "$@" \
  "$url"
