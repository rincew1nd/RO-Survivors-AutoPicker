#!/usr/bin/env sh
# Builds the Chrome package into dist/v<version>.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
src="$root/src"

version=${1:-}
if [ -z "$version" ]; then
  version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$src/manifest.json" | head -n 1)
fi
[ -n "$version" ] || { echo "version not found in src/manifest.json" >&2; exit 1; }

out="$root/dist/v$version"
rm -rf "$out"
mkdir -p "$out/chrome"
cp -R "$src"/. "$out/chrome/"
cp "$src/README.txt" "$out/README.txt"

if command -v python3 >/dev/null 2>&1; then py=python3; else py=python; fi
"$py" - "$out" "$version" <<'PY'
import os, sys, zipfile

out, version = sys.argv[1], sys.argv[2]
src = os.path.join(out, "chrome")
dst = os.path.join(out, f"ro-survivors-autopick-v{version}-chrome.zip")
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, _, names in os.walk(src):
        for name in names:
            path = os.path.join(dirpath, name)
            z.write(path, os.path.relpath(path, src).replace(os.sep, "/"))
PY

echo "Built dist/v$version"
