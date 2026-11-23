#!/usr/bin/env bash
set -euo pipefail

arch=${1:-$(node -p 'process.arch')}
native=node_modules/better-sqlite3/build/Release/better_sqlite3.node
limit=GLIBC_2.28
if [[ $arch == arm64 ]]; then
  # AArch64 has 64-bit off_t natively. The explicit large-file alias
  # fcntl64 introduced by glibc 2.28 prevents older desktops from loading SQLite.
  export CFLAGS="${CFLAGS:+$CFLAGS }-U_FILE_OFFSET_BITS -DSQLITE_DISABLE_LFS"
  limit=GLIBC_2.17
fi

npm_config_build_from_source=true npm run rebuild:electron -- --arch="$arch"
if [[ $arch == arm64 ]] && ! LC_ALL=C readelf -h "$native" | grep -q 'Machine:.*AArch64'; then
  echo "better_sqlite3.node 需要使用 AArch64 编译器构建" >&2
  exit 1
fi
node scripts/check-native-glibc.cjs "$native" "$limit"
