import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const port = process.env.PORT ?? "3000";
const host = `http://127.0.0.1:${port}`;
const tsxEntry = "node_modules/tsx/dist/cli.mjs";
// テスト用データは一時ディレクトリへ分離する。従来は開発者の data/ をそのまま使い、
// テストのたびに auth.json へユーザーが残り続け、保存済みレシピや実行履歴も汚染されていた（E2E ランナーと同じ方式）。
const dataDir = await mkdtemp(path.join(tmpdir(), "mojule-smoke-data-"));
const server = spawn(process.execPath, [tsxEntry, "server/index.ts"], {
  stdio: "ignore",
  env: {
    ...process.env,
    PORT: port,
    NODE_ENV: "test",
    MOJULE_LLM_ENABLED: "false",
    RECIPES_FILE: path.join(dataDir, "recipes.json"),
    RUN_HISTORY_FILE: path.join(dataDir, "runs.json"),
    AUTH_FILE: path.join(dataDir, "auth.json"),
  },
  windowsHide: true,
  // tsxはラッパーが子プロセスを起動するため、SIGTERMだけでは子が残る。
  // プロセスグループごと終了させて取り残しを防ぐ（Windowsでは個別に終了）。
  detached: process.platform !== "win32",
});
server.unref();

try {
  if (!existsSync(tsxEntry)) {
    throw new Error(
      "tsx が見つかりません。先に pnpm install を実行してください。",
    );
  }
  let ready = false;
  // CIの冷えた環境では初回起動が遅いため、待ち時間は長めに取る（250ms × 120回＝30秒）。
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${host}/api/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // サーバー起動待ち
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) {
    throw new Error(
      "Mojule サーバーが起動せず、スモークテストを開始できませんでした。",
    );
  }
  execFileSync(process.execPath, ["--test", "test/smoke.mjs"], {
    stdio: "inherit",
    env: { ...process.env, PORT: port },
    windowsHide: true,
  });
  execFileSync(process.execPath, ["--test", "test/contract.mjs"], {
    stdio: "inherit",
    env: { ...process.env, PORT: port },
    windowsHide: true,
  });
} finally {
  // SIGTERMではtsxの子プロセスが残るため、グループごとSIGKILLで止める。
  try {
    if (process.platform !== "win32") process.kill(-server.pid, "SIGKILL");
    else server.kill("SIGKILL");
  } catch {
    server.kill();
  }
}
