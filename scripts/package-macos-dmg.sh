#!/usr/bin/env bash
set -euo pipefail

target="${1:?missing Rust target triple}"
asset_suffix="${2:?missing release asset suffix}"

version="$(node -p "require('./package.json').version")"
app_path="src-tauri/target/${target}/release/bundle/macos/FlyPassword.app"
upload_dir="src-tauri/target/release-upload"
stage_root="${upload_dir}/${asset_suffix}"
stage_dir="${stage_root}/FlyPassword"
dmg_path="${upload_dir}/FlyPassword-v${version}-${asset_suffix}.dmg"

if [[ ! -d "${app_path}" ]]; then
  echo "App bundle not found: ${app_path}" >&2
  exit 1
fi

codesign --force --deep --sign - --timestamp=none "${app_path}"
codesign --verify --deep --strict --verbose=2 "${app_path}"

rm -rf "${stage_root}"
mkdir -p "${stage_dir}" "${upload_dir}"
ditto "${app_path}" "${stage_dir}/FlyPassword.app"
ln -s /Applications "${stage_dir}/Applications"

rm -f "${dmg_path}"
hdiutil create -volname FlyPassword -srcfolder "${stage_dir}" -ov -format UDZO "${dmg_path}"
hdiutil verify "${dmg_path}"

mount_point="$(mktemp -d /tmp/flypassword-dmg-check.XXXXXX)"
attached=0
cleanup() {
  if [[ "${attached}" == "1" ]]; then
    hdiutil detach "${mount_point}" >/dev/null || true
  fi
  rmdir "${mount_point}" 2>/dev/null || true
}
trap cleanup EXIT

hdiutil attach -nobrowse -readonly -mountpoint "${mount_point}" "${dmg_path}" >/dev/null
attached=1
codesign --verify --deep --strict --verbose=2 "${mount_point}/FlyPassword.app"

echo "${dmg_path}"
