#!/usr/bin/env bash
# mojule のフルビルドを 1 コマンドで行うスクリプト。
# 依存関係のインストール → 一括検証 (型検査 → テスト → ビルド → ブラウザE2E) を
# 順に実行し、失敗したステップで即座に止まって、どのステップで落ちたかを表示する。
# 一括検証は repo 標準の `pnpm verify` (scripts/verify.mjs) を使う。
# ブラウザE2E は Chrome が見つからない環境では自動でスキップされる。

# ===== 1. 準備 =====
set -euo pipefail
cd "$(dirname "$0")"

step() {
  echo
  echo "===== $1 ====="
}

fail() {
  echo "ERROR: ステップが失敗しました: $1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "前提チェック (Node.js が見つかりません)"
command -v pnpm >/dev/null 2>&1 || fail "前提チェック (pnpm が見つかりません。corepack enable などで pnpm 10.18.0 を用意してください)"

# ===== 2. 依存関係のインストール =====
step "1/2 依存関係のインストール"
pnpm install --frozen-lockfile || fail "依存関係のインストール (pnpm install --frozen-lockfile)"

# ===== 3. 一括検証 (型検査・テスト・ビルド・ブラウザE2E) =====
step "2/2 一括検証 (pnpm verify)"
pnpm verify || fail "一括検証 (pnpm verify)"

# ===== 4. 完了 =====
echo
echo "BUILD OK: mojule の型検査・テスト・ビルドがすべて成功しました (成果物: dist/)"
