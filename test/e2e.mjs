import assert from "node:assert/strict";
import test, { after, before } from "node:test";

// ==========================================
// 🖥️ ブラウザE2Eテスト
// ==========================================
// ブラウザE2E: 本番ビルドを起動したサーバーへヘッドレスChromiumで接続し、
// 画面の描画からレシピ実行・保存までの一連の流れを検証する。
// サーバーとブラウザの起動は scripts/run-e2e-tests.mjs が行う。
const baseUrl = process.env.E2E_BASE_URL || "http://127.0.0.1:3100";
const cdpPort = process.env.E2E_CDP_PORT || "9333";

let ws;
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
const failedRequests = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      `page evaluation failed: ${JSON.stringify(result.exceptionDetails)}`,
    );
  }
  return result.result.value;
}

async function waitFor(expression, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(expression)) return;
    } catch {
      // ⚠️ ページ遷移直後は document.body がまだ null などで評価が失敗する。
      // 一時的な状態なので、タイムアウトまで待ってから失敗にする。
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for: ${expression}`);
}

function clickButton(label) {
  return evaluate(
    `(() => { const button = [...document.querySelectorAll("button")].find(item => item.textContent.includes(${JSON.stringify(label)})); if (!button) throw new Error("button not found: " + ${JSON.stringify(label)}); button.click(); return true; })()`,
  );
}

before(async () => {
  const targets = await (
    await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
  ).json();
  const page = targets.find((target) => target.type === "page");
  assert.ok(page, "no debuggable page target found");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () =>
      reject(new Error("failed to connect to Chrome DevTools"));
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") {
      consoleErrors.push(
        message.params.exceptionDetails?.text || "page exception",
      );
    } else if (
      message.method === "Runtime.consoleAPICalled" &&
      message.params.type === "error"
    ) {
      consoleErrors.push(
        message.params.args
          .map((arg) => arg.value ?? arg.description ?? "")
          .join(" "),
      );
    } else if (
      message.method === "Network.responseReceived" &&
      message.params.response.status >= 400
    ) {
      failedRequests.push(
        `${message.params.response.status} ${message.params.response.url}`,
      );
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Page.navigate", { url: `${baseUrl}/` });
  await waitFor(`document.body?.innerText?.includes("MODULE REGISTRY")`);
});

after(() => {
  ws?.close();
});

test("app renders the module registry from the live api", async () => {
  await waitFor(`document.body?.innerText?.includes("7 modules")`);
  assert.equal(
    await evaluate(`document.body?.innerText?.includes("ai.respond")`),
    true,
  );
  assert.equal(
    await evaluate(`document.body?.innerText?.includes("text.summarize")`),
    true,
  );
  assert.equal(
    await evaluate(
      `document.querySelector("#message")?.value.includes("mojuleagent")`,
    ),
    true,
  );
});

test("running the default recipe from the ui shows a demo answer", async () => {
  await clickButton("レシピを実行");
  await waitFor(`document.body?.innerText?.includes("実行結果")`);
  await waitFor(`document.body?.innerText?.includes("LOCAL DEMO")`);
  const answer = await evaluate(
    `document.querySelector(".answer p")?.textContent || ""`,
  );
  assert.ok(answer.length > 0, "answer paragraph should not be empty");
  assert.match(answer, /mojuleagentの考え方/);
  assert.equal(
    await evaluate(`document.body?.innerText?.includes("RUN ")`),
    true,
  );
  await waitFor(`document.querySelectorAll(".history-grid button").length > 0`);
});

test("saving a recipe from the ui appears in saved recipes", async () => {
  await clickButton("保存");
  await waitFor(
    `[...document.querySelectorAll(".saved-grid button")].some(item => item.textContent.includes("My first recipe"))`,
  );
  const listed = await (await fetch(`${baseUrl}/api/recipes`)).json();
  assert.ok(listed.recipes.some((item) => item.name === "My first recipe"));
});

test("no page errors or failed requests occurred", async () => {
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(failedRequests, []);
});
