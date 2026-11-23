#!/usr/bin/env bash
set -euo pipefail

# 决议 #300：先跳过自动钩子，避免 better-sqlite3 在依赖安装、根 postinstall 和强制重建中反复编译。
npm ci --ignore-scripts --prefer-offline --no-audit --no-fund
# 恢复锁文件中其余 Linux 依赖的安装钩子；fsevents 仅适用于 macOS。
npm rebuild electron esbuild protobufjs vue-demi
bash scripts/rebuild-linux-native.sh
