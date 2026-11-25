import { execFileSync, execSync, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ==========================================
// 🖥️ ブラウザE2Eランナー
// ==========================================
// ブラウザE2Eランナー: 本番ビルドを起動し、ヘッドレスChromiumで test/e2e.mjs を実行する。
// Chromeが見つからない環境ではスキップして終了コード0で終わる（CIでは setup-chrome で用意する）。
const port = process.env.E2E_PORT ?? "3100";
const cdpPort = process.env.E2E_CDP_PORT ?? "9333";
const host = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveChrome() {
  for (const candidate of [
    process.env.CHROMIUM_BINARY,
    process.env.JARVIS_CHROMIUM_BINARY,
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  for (const name of [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
  ]) {
    try {
      const found = execSync(`command -v ${name}`, { encoding: "utf8" }).trim();
      if (found) return found;
    } catch {
      // 📌 次の候補へ
    }
  }
  // 🖥️ /opt/meta-chromium/chrome はプラットフォームのブラウザで直接起動できないため候補にしない。
  return null;
}

const chrome = resolveChrome();
if (!chrome) {
  console.log(
    "E2Eをスキップします: ヘッドレスブラウザが見つかりませんでした。CHROMIUM_BINARY を設定するか Chrome をインストールしてください。",
  );
  process.exit(0);
}
console.log(`Chrome: ${chrome}`);
try {
  console.log(execFileSync(chrome, ["--version"], { encoding: "utf8" }).trim());
} catch {
  console.log("Chromeのバージョンを確認できませんでした。");
}

const dataDir = await mkdtemp(path.join(tmpdir(), "mojule-e2e-data-"));
const profileDir = await mkdtemp(path.join(tmpdir(), "mojule-e2e-profile-"));
// 🖥️ Chromeの標準エラー出力はファイルに残し、起動失敗時にログへ出す。
const chromeLogPath = path.join(dataDir, "chrome.log");
const chromeLogStream = createWriteStream(chromeLogPath);
const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

if (!existsSync("dist/index.js")) {
  console.log("本番ビルドが無いため pnpm build を実行します。");
  execFileSync(command, ["build"], { stdio: "inherit", shell: false });
}

const server = spawn(process.execPath, ["dist/index.js"], {
  stdio: "ignore",
  env: {
    ...process.env,
    PORT: port,
    NODE_ENV: "production",
    MOJULE_LLM_ENABLED: "false",
    RECIPES_FILE: path.join(dataDir, "recipes.json"),
    RUN_HISTORY_FILE: path.join(dataDir, "runs.json"),
    AUTH_FILE: path.join(dataDir, "auth.json"),
  },
  windowsHide: true,
  detached: process.platform !== "win32",
});

const browser = spawn(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ],
  {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  },
);
browser.stderr.pipe(chromeLogStream);

// ⏳ CIの冷えた環境では初回起動が遅いため、待ち時間は長めに取る（250ms × 回数）。
async function waitFor(url, label, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // ⏳ 起動待ち
    }
    await sleep(250);
  }
  throw new Error(`${label} が起動しませんでした: ${url}`);
}

try {
  await waitFor(`${host}/api/health`, "Mojuleサーバー", 120);
  try {
    await waitFor(
      `http://127.0.0.1:${cdpPort}/json/version`,
      "ヘッドレスブラウザ",
      240,
    );
  } catch (error) {
    try {
      const log = await readFile(chromeLogPath, "utf8");
      if (log.trim())
        console.error(
          `--- Chrome stderr (${chromeLogPath}) ---\n${log.slice(-4000)}`,
        );
    } catch {
      // ⚠️ ログが読めなくても元のエラーをそのまま出す
    }
    throw error;
  }
  execFileSync(process.execPath, ["--test", "test/e2e.mjs"], {
    stdio: "inherit",
    env: { ...process.env, E2E_BASE_URL: host, E2E_CDP_PORT: cdpPort },
    windowsHide: true,
  });
  console.log("\n✅ ブラウザE2Eが完了しました");
} finally {
  for (const child of [browser, server]) {
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill();
    }
  }
}
