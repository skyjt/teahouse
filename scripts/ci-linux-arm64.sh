#!/usr/bin/env bash
set -euo pipefail

cat >/etc/apt/sources.list <<'APT'
deb http://archive.debian.org/debian buster main contrib non-free
deb http://archive.debian.org/debian-security buster/updates main contrib non-free
deb http://archive.debian.org/debian buster-updates main contrib non-free
APT
printf 'Acquire::Check-Valid-Until "false";\n' >/etc/apt/apt.conf.d/99no-check-valid-until
apt-get update
# rpm 已移除（决议 #206）：dist 只打 deb/AppImage，装 rpm 纯属浪费
apt-get install -y --no-install-recommends \
  git ca-certificates python3 make g++ pkg-config dpkg fakeroot ruby ruby-dev libffi-dev squashfs-tools \
  xvfb xauth dbus-x11 libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 \
  xdg-utils libatspi2.0-0 libuuid1 libfuse2 libasound2 libgbm1 \
  libdrm2 libx11-xcb1
rm -rf /var/lib/apt/lists/*

bash scripts/ci-install-linux.sh

npm test
npm run test:db
npm run typecheck
npm run build
# CI 容器以 root 运行，Electron 启动冒烟需关闭 Chromium sandbox；应用运行时安全配置不变。
xvfb-run -a npx --no-install cross-env PANTRY_SMOKE=1 electron . --no-sandbox

# gem 缓存命中（release.yml 的 actions/cache）时跳过安装（决议 #206）
if command -v fpm >/dev/null 2>&1 && fpm --version 2>/dev/null | grep -q '^1\.9\.3$'; then
  echo "fpm 1.9.3 已就绪（缓存命中），跳过 gem install"
else
  gem install --no-document ffi -v 1.15.5
  gem install --no-document fpm -v 1.9.3
fi
USE_SYSTEM_FPM=true USE_HARD_LINKS=false npx --no-install electron-builder --linux deb:arm64 AppImage:arm64 --publish never

deb=$(ls release/Teahouse-*-linux-arm64.deb)
verify=$(mktemp -d)
trap 'rm -rf "$verify"' EXIT
dpkg-deb -x "$deb" "$verify"
installed="$verify/opt/Teahouse"
node scripts/check-native-glibc.cjs "$installed/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node" GLIBC_2.17
PANTRY_USER_DATA="$verify/profile" PANTRY_SMOKE=1 xvfb-run -a "$installed/pantry" --no-sandbox
listing=$(dpkg-deb -c "$deb")
if grep -P '^h' <<< "$listing"; then
  echo "deb 内含硬链接条目，UOS 深度安装器会失败" >&2
  exit 1
fi
if grep -P '[\x{4e00}-\x{9fff}]' <<< "$listing"; then
  echo "deb 安装路径含中文" >&2
  exit 1
fi
echo "deb 校验通过：无硬链接、无中文路径"

cd release
shopt -s nullglob
files=(Teahouse-*-linux-arm64.deb Teahouse-*-linux-arm64.AppImage)
if [ "${#files[@]}" -lt 2 ]; then
  ls -la
  echo "Linux arm64 产物数量不足，期望 deb 与 AppImage 各一个。" >&2
  exit 1
fi
sha256sum "${files[@]}" > SHA256SUMS-debian10-uos20-arm64.txt
