#!/usr/bin/env bash
#
# Builds the Chrome Web Store upload zip.
#
# Allowlist, never a blocklist. This repository sits next to material that must
# never be published: .secrets/ holds the extension's PRIVATE signing key,
# oauth-backend/ holds the Cloudflare Worker (including .dev.vars and tens of
# megabytes of .wrangler/ miniflare state). A `zip -r . -x ...` that is one
# forgotten pattern short of correct ships the signing key to the world, so
# this names what goes in instead of guessing at what stays out.
#
# Usage: ./scripts/pack.sh [output.zip]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./manifest.json').version")"
OUT="${1:-dist/algopush-${VERSION}.zip}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Exactly what ships. Add a line here when the extension gains a file.
PAYLOAD=(
    manifest.json
    background
    content-scripts
    options
    popup
    shared
    images
    fonts
)

for item in "${PAYLOAD[@]}"; do
    if [[ ! -e "$item" ]]; then
        echo "pack: missing required payload entry '$item'" >&2
        exit 1
    fi
    cp -R "$item" "$STAGE/"
done

# NOTE: manifest.json's `key` field is deliberately KEPT in the upload.
# It pins the extension ID to oflhjpbehioebeaologailkkfbmleipl, and the
# Codeforces OAuth app's registered redirect URI
# (https://oflhjpbehioebeaologailkkfbmleipl.chromiumapp.org/) is derived from
# exactly that ID. Stripping the key would hand the published extension a
# different ID and break "Connect Codeforces Account" in production. The key
# is the PUBLIC half; the private .pem in .secrets/ is what must never ship,
# and the allowlist plus the guard below keep it out.

# Belt and braces: fail loudly if anything sensitive made it into the staging
# directory, whatever the allowlist above says.
if find "$STAGE" \( -name '*.pem' -o -name '.dev.vars' -o -name '.wrangler' -o -name '.secrets' \) -print -quit | grep -q .; then
    echo "pack: refusing to package — sensitive files found in staging" >&2
    exit 1
fi

# The icon is shipped, shown in the toolbar, and used for every notification.
# A placeholder pixel passes every other check in this script and is rejected
# by the Web Store only after upload, so it is caught here instead.
node -e '
const fs = require("fs");
const buf = fs.readFileSync(process.argv[1]);
if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    console.error("pack: images/icon128.png is not a PNG");
    process.exit(1);
}
const width = buf.readUInt32BE(16);
const height = buf.readUInt32BE(20);
if (width < 128 || height < 128) {
    console.error(`pack: images/icon128.png is ${width}x${height}; the Web Store requires a real 128x128 icon`);
    process.exit(1);
}
' "$STAGE/images/icon128.png"

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
( cd "$STAGE" && zip -qr "$OLDPWD/$OUT" . -x '.*' '*/.*' )

echo "Packed v${VERSION} -> ${OUT}"
unzip -l "$OUT" | tail -n 1
