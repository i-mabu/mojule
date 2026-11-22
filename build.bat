@echo off
rem mojule のフルビルドを 1 コマンドで行うスクリプト (Windows 用)。
rem 依存関係のインストール → 一括検証 (型検査 → テスト → ビルド → ブラウザE2E) を
rem 順に実行し、失敗したステップで即座に止まって、どのステップで落ちたかを表示する。
rem 一括検証は repo 標準の `pnpm verify` (scripts/verify.mjs) を使う。
rem ブラウザE2E は Chrome が見つからない環境では自動でスキップされる。
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo ERROR: pnpm が見つかりません。corepack enable などで pnpm 10.18.0 を用意してください。 1>&2
  exit /b 1
)

echo.
echo ===== 1/2 依存関係のインストール =====
call pnpm install --frozen-lockfile
if errorlevel 1 goto fail_install

echo.
echo ===== 2/2 一括検証 (pnpm verify) =====
call pnpm verify
if errorlevel 1 goto fail_verify

echo.
echo BUILD OK: mojule の型検査・テスト・ビルドがすべて成功しました (成果物: dist/)
exit /b 0

:fail_install
echo ERROR: ステップが失敗しました: 依存関係のインストール (pnpm install --frozen-lockfile) 1>&2
exit /b 1

:fail_verify
echo ERROR: ステップが失敗しました: 一括検証 (pnpm verify) 1>&2
exit /b 1
