# 🧪 テスト方針

## ✅ 必須チェック

- `pnpm check`: TypeScript 型検査
- `pnpm test`: Node スモークテストと API 契約テスト
- `pnpm test:e2e`: ブラウザ E2E（Chrome が必要、無い場合はスキップ）
- `pnpm build`: Vite と Express バンドル

## 📜 API 契約テスト

`test/contract.mjs` は `/api/openapi.json` の仕様と実装の一致を検証します。

- 仕様の構造（`$ref` の解決、タグ、セキュリティスキーム）
- 仕様に載る全操作へのプローブ（仕様に追加された操作にプローブが無いと失敗する）
- エラー封筒 `{ error: { code, message }, requestId }` と `x-request-id` ヘッダー
- 成功レスポンスの形状、レート制限ヘッダー
- `AUTH_REQUIRED=true` の別サーバーでの認証・RBAC 境界

## 🌐 ブラウザ E2E

`test/e2e.mjs` は本番ビルドを起動し、ヘッドレス Chrome（CDP 経由）で画面を操作します。

- レジストリの描画、レシピ実行とデモ回答、UI からのレシピ保存
- ページエラーと失敗リクエストが無いこと
- Chrome は `CHROMIUM_BINARY` 環境変数か PATH から探す。見つからない場合はスキップする（CI では setup-chrome で用意する）

## 🔍 重点境界

- レシピのノード数、ID、ポート接続の検証
- API キーのハッシュ保存と再表示不可
- `AUTH_REQUIRED=true` の認証・RBAC
- ジョブの `queued` / `running` / `completed` / `failed` / `cancelled`
- LLM 無効時のローカルデモ動作
- 1MB リクエスト、12,000 文字、毎分レート制限

## 🔜 次の強化

- 共有ストアを使った複数ワーカーのジョブテスト
