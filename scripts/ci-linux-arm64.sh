#!/usr/bin/env bash
set -euo pipefail

cat >/etc/apt/sources.list <<'APT'
deb http://archive.debian.org/debian buster main contrib non-free
deb http://archive.debian.org/debian-security buster/updates main contrib non-free
deb http://archive.debian.org/debian buster-updates main contrib non-free
APT
printf 'Acquire::Check-Valid-Until "false";\n' >/etc/apt/apt.conf.d/99no-check-valid-until
apt-get update
apt-get install -y --no-install-recommends \
  git ca-certificates python3 make g++ pkg-config dpkg fakeroot rpm ruby ruby-dev libffi-dev squashfs-tools \
  xvfb xauth dbus-x11 libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 \
  xdg-utils libatspi2.0-0 libuuid1 libfuse2 libasound2 libgbm1 \
  libdrm2 libx11-xcb1
rm -rf /var/lib/apt/lists/*

npm ci

npm run rebuild:electron
node scripts/check-native-glibc.cjs node_modules/better-sqlite3/build/Release/better_sqlite3.node

npm test
npm run test:db
npm run typecheck
npm run build
# CI 容器以 root 运行，Electron 启动冒烟需关闭 Chromium sandbox；应用运行时安全配置不变。
xvfb-run -a npm run smoke -- --no-sandbox

gem install --no-document ffi -v 1.15.5
gem install --no-document fpm -v 1.9.3
USE_SYSTEM_FPM=true USE_SYSTEM_MKSQUASHFS=true USE_HARD_LINKS=false npm run dist:linux:arm64

native=$(find release -path '*/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node' -print | sort | head -1)
if [ -z "$native" ]; then
  find release -maxdepth 3 -type f | sort
  echo "未找到 arm64 打包产物中的 better_sqlite3.node" >&2
  exit 1
fi
node scripts/check-native-glibc.cjs "$native"

deb=$(ls release/Teahouse-*-linux-arm64.deb)
mkdir -p /tmp/deb-verify
data=$(ar t "$deb" | grep '^data\.tar')
ar p "$deb" "$data" > "/tmp/deb-verify/$data"
listing=$(tar -tvf "/tmp/deb-verify/$data")
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
