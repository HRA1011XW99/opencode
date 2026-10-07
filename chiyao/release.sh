#!/usr/bin/env bash
# 编译 Windows x64 的 opencode.exe 并发布到 HRA1011XW99/opencode 的 Release。
#
#   bash chiyao/release.sh 1          标签 chiyao-v<上游版本>-1，版本号 <上游版本>-chiyao.1
#
# 上游版本取 packages/opencode/package.json。版本号必须带上游版本：OpenCode Zen 的
# 免费模型按版本号拒绝过旧的客户端。发布完把输出的那一行写进吃药机仓库的
# desktop/opencode.version，再按吃药机的流程发新版。
set -euo pipefail
n="${1:?用法：bash chiyao/release.sh <本次序号>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
pkg="$root/packages/opencode"
up="$(cd "$pkg" && node -p "require('./package.json').version")"
tag="chiyao-v$up-$n"
ver="$up-chiyao.$n"

cd "$root"
bun install --ignore-scripts
cd "$pkg"
OPENCODE_VERSION="$ver" bun run script/build.ts --single --skip-embed-web-ui
exe="$pkg/dist/opencode-windows-x64/bin/opencode.exe"
"$exe" --version
sum="$(sha256sum "$exe" | cut -d' ' -f1)"
echo "$sum  opencode.exe" > "$pkg/dist/opencode.exe.sha256"

cd "$root"
git tag -f "$tag"
git push -f origin "$tag"
gh release create "$tag" -R HRA1011XW99/opencode --title "$tag" \
  --notes "吃药机工作 App 用的 opencode（$ver）。SHA-256：$sum" \
  "$exe" "$pkg/dist/opencode.exe.sha256"
echo
echo "写进吃药机 desktop/opencode.version："
echo "$tag $sum"
