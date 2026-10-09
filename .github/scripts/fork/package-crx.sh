#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${CRX_SIGNING_KEY:-}" ]]; then
  echo '::error::CRX_SIGNING_KEY is required to keep the extension ID stable.'
  exit 1
fi
key_file=$(mktemp "$RUNNER_TEMP/notion-key.XXXXXX.pem")
trap 'rm -f "$key_file"' EXIT
chmod 600 "$key_file"
printf '%s\n' "$CRX_SIGNING_KEY" > "$key_file"
unset CRX_SIGNING_KEY
openssl pkey -in "$key_file" -check -noout >/dev/null 2>&1
public_key=$(openssl pkey -in "$key_file" -pubout -outform DER | base64 -w0)
export NOTION_PUBLIC_KEY="$public_key"
version=$(node --input-type=module <<'JS'
import fs from 'node:fs';
const path = '.output/chrome-mv3/manifest.json';
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
const base = manifest.version.split('.').slice(0, 3);
const build = Number(process.env.GITHUB_RUN_NUMBER);
if (!Number.isInteger(build) || build < 1 || build > 65535) throw new Error('Build number exceeds Chrome version bounds.');
manifest.version_name = `${manifest.version}-notion.${build}`;
manifest.version = [...base, String(build)].join('.');
manifest.key = process.env.NOTION_PUBLIC_KEY;
fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
console.log(manifest.version);
JS
)
unset NOTION_PUBLIC_KEY
extension_dir="$PWD/.output/chrome-mv3"
timeout 60s google-chrome --headless=new --no-sandbox --disable-gpu --no-message-box \
  --user-data-dir="$RUNNER_TEMP/notion-pack-profile" \
  --pack-extension="$extension_dir" --pack-extension-key="$key_file"
test -s "$extension_dir.crx"
mkdir -p .output/notion-packages
stem="readfrog-notion-$version"
cp "$extension_dir.crx" ".output/notion-packages/$stem.crx"
(cd "$extension_dir" && zip -qr "../notion-packages/$stem.zip" .)
(cd .output/notion-packages && sha256sum ./*.crx ./*.zip > SHA256SUMS.txt)
echo "version=$version" >> "$GITHUB_OUTPUT"
printf 'Built signed CRX and ZIP for `%s`.\n' "$version" >> "$GITHUB_STEP_SUMMARY"
