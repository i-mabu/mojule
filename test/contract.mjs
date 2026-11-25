import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ==========================================
// 📜 API契約テスト
// ==========================================
// API契約テスト: /api/openapi.json の仕様と実際のサーバー動作が一致することを検証する。
// 実行は scripts/run-smoke-tests.mjs がサーバーを起動してから行う。
const base = `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
const recipe = {
  id: "contract-recipe",
  name: "Contract Recipe",
  description: "contract test",
  nodes: [
    { id: "input", moduleId: "input.message" },
    { id: "respond", moduleId: "ai.respond" },
    { id: "output", moduleId: "output.markdown" },
  ],
};

async function call(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, headers: response.headers, text, body };
}

async function fetchSpec() {
  const response = await fetch(`${base}/api/openapi.json`);
  assert.equal(response.status, 200);
  return response.json();
}

function collectRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" && typeof item === "string") refs.push(item);
      else collectRefs(item, refs);
    }
  }
  return refs;
}

function resolveRef(spec, ref) {
  const parts = ref.replace(/^#\//, "").split("/");
  let current = spec;
  for (const part of parts) {
    current = current?.[part];
    if (current === undefined) return undefined;
  }
  return current;
}

// 📌 Expressの未定義ルートは text/html の "Cannot GET ..." を返す。
// ハンドラーが返した404はJSONのエラー封筒になるため、両者を区別できる。
function assertRouteExists(result) {
  const contentType = result.headers.get("content-type") || "";
  assert.ok(
    !(result.status === 404 && contentType.includes("text/html")),
    `route is not implemented (Express default 404): ${result.status} ${result.text.slice(0, 120)}`,
  );
}

async function createJob() {
  const created = await call("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ message: "contract job" }),
  });
  assert.equal(created.status, 202);
  return created.body.job.id;
}

test("openapi document is structurally valid and every $ref resolves", async () => {
  const spec = await fetchSpec();
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.info.title, "mojuleagent API");
  assert.equal(typeof spec.info.version, "string");
  const tagNames = new Set((spec.tags || []).map((tag) => tag.name));
  for (const ref of collectRefs(spec)) {
    assert.ok(ref.startsWith("#/components/"), `unexpected $ref: ${ref}`);
    assert.notEqual(
      resolveRef(spec, ref),
      undefined,
      `unresolved $ref: ${ref}`,
    );
  }
  for (const [pathName, pathItem] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      assert.ok(
        operation.responses,
        `${method.toUpperCase()} ${pathName} has no responses`,
      );
      for (const status of Object.keys(operation.responses)) {
        assert.match(
          status,
          /^\d{3}$/,
          `${method.toUpperCase()} ${pathName} has invalid response status: ${status}`,
        );
      }
      for (const tag of operation.tags || []) {
        assert.ok(
          tagNames.has(tag),
          `${method.toUpperCase()} ${pathName} uses unknown tag: ${tag}`,
        );
      }
      for (const security of operation.security || []) {
        for (const scheme of Object.keys(security)) {
          assert.ok(
            spec.components.securitySchemes[scheme],
            `${method.toUpperCase()} ${pathName} uses unknown security scheme: ${scheme}`,
          );
        }
      }
    }
  }
});

// 📌 仕様に載っている全操作を実際に叩き、ルートが存在することと
// 期待するステータスが返ることを確認する。プローブが無い操作が
// 仕様に追加された場合はこのテストが失敗して気付ける。
const probes = {
  "get /api/health": async () => ({
    ...(await call("/api/health")),
    expected: 200,
  }),
  "get /api/modules": async () => ({
    ...(await call("/api/modules")),
    expected: 200,
  }),
  "get /api/marketplace": async () => ({
    ...(await call("/api/marketplace")),
    expected: 200,
  }),
  "post /api/auth/register": async () => ({
    ...(await call("/api/auth/register", { method: "POST", body: "{}" })),
    expected: 400,
  }),
  "post /api/auth/login": async () => ({
    ...(await call("/api/auth/login", { method: "POST", body: "{}" })),
    expected: 400,
  }),
  "post /api/auth/logout": async () => ({
    ...(await call("/api/auth/logout", { method: "POST" })),
    expected: 204,
  }),
  "get /api/auth/me": async () => ({
    ...(await call("/api/auth/me")),
    expected: 200,
  }),
  "post /api/auth/accept-invite": async () => ({
    ...(await call("/api/auth/accept-invite", { method: "POST", body: "{}" })),
    expected: 400,
  }),
  "get /api/workspace": async () => ({
    ...(await call("/api/workspace")),
    expected: 401,
  }),
  "get /api/workspace/members": async () => ({
    ...(await call("/api/workspace/members")),
    expected: 401,
  }),
  "post /api/workspace/invitations": async () => ({
    ...(await call("/api/workspace/invitations", {
      method: "POST",
      body: JSON.stringify({
        email: "contract@example.com",
        name: "Contract",
        role: "editor",
      }),
    })),
    expected: 401,
  }),
  "patch /api/workspace/members/{id}": async () => ({
    ...(await call("/api/workspace/members/someone", {
      method: "PATCH",
      body: JSON.stringify({ role: "viewer" }),
    })),
    expected: 401,
  }),
  "delete /api/workspace/members/{id}": async () => ({
    ...(await call("/api/workspace/members/someone", { method: "DELETE" })),
    expected: 401,
  }),
  "get /api/workspace/api-keys": async () => ({
    ...(await call("/api/workspace/api-keys")),
    expected: 401,
  }),
  "post /api/workspace/api-keys": async () => ({
    ...(await call("/api/workspace/api-keys", {
      method: "POST",
      body: JSON.stringify({ name: "Contract" }),
    })),
    expected: 401,
  }),
  "delete /api/workspace/api-keys/{id}": async () => ({
    ...(await call("/api/workspace/api-keys/some-key", { method: "DELETE" })),
    expected: 401,
  }),
  "get /api/recipes": async () => ({
    ...(await call("/api/recipes")),
    expected: 200,
  }),
  "post /api/recipes": async () => ({
    ...(await call("/api/recipes", {
      method: "POST",
      body: JSON.stringify(recipe),
    })),
    expected: 201,
  }),
  "post /api/recipes/validate": async () => ({
    ...(await call("/api/recipes/validate", {
      method: "POST",
      body: JSON.stringify(recipe),
    })),
    expected: 200,
  }),
  "get /api/recipes/{id}": async () => ({
    ...(await call("/api/recipes/no-such-recipe")),
    expected: 404,
  }),
  "put /api/recipes/{id}": async () => {
    await call("/api/recipes", {
      method: "POST",
      body: JSON.stringify(recipe),
    });
    return {
      ...(await call("/api/recipes/contract-recipe", {
        method: "PUT",
        body: JSON.stringify(recipe),
      })),
      expected: 200,
    };
  },
  "delete /api/recipes/{id}": async () => {
    await call("/api/recipes", {
      method: "POST",
      body: JSON.stringify(recipe),
    });
    return {
      ...(await call("/api/recipes/contract-recipe", { method: "DELETE" })),
      expected: 204,
    };
  },
  "post /api/recipes/{id}/run": async () => {
    await call("/api/recipes", {
      method: "POST",
      body: JSON.stringify(recipe),
    });
    return {
      ...(await call("/api/recipes/contract-recipe/run", {
        method: "POST",
        body: JSON.stringify({ message: "contract run" }),
      })),
      expected: 200,
    };
  },
  "post /api/run": async () => ({
    ...(await call("/api/run", {
      method: "POST",
      body: JSON.stringify({ message: "contract" }),
    })),
    expected: 200,
  }),
  "post /api/ask": async () => ({
    ...(await call("/api/ask", {
      method: "POST",
      body: JSON.stringify({ message: "contract" }),
    })),
    expected: 200,
  }),
  "get /api/runs": async () => ({
    ...(await call("/api/runs")),
    expected: 200,
  }),
  "get /api/runs/{id}": async () => ({
    ...(await call("/api/runs/no-such-run")),
    expected: 404,
  }),
  "get /api/jobs": async () => ({
    ...(await call("/api/jobs")),
    expected: 200,
  }),
  "post /api/jobs": async () => ({
    ...(await call("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ message: "contract" }),
    })),
    expected: 202,
  }),
  "get /api/jobs/{id}": async () => ({
    ...(await call("/api/jobs/no-such-job")),
    expected: 404,
  }),
  "get /api/jobs/{id}/events": async () => {
    const jobId = await createJob();
    const controller = new AbortController();
    const response = await fetch(`${base}/api/jobs/${jobId}/events`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") || "",
      /text\/event-stream/,
    );
    const reader = response.body.getReader();
    const { value } = await reader.read();
    controller.abort();
    const chunk = new TextDecoder().decode(value);
    assert.match(chunk, /^data: /);
    return {
      status: 200,
      headers: response.headers,
      text: chunk,
      body: undefined,
      expected: 200,
    };
  },
  "post /api/jobs/{id}/cancel": async () => {
    const jobId = await createJob();
    return {
      ...(await call(`/api/jobs/${jobId}/cancel`, { method: "POST" })),
      expected: 200,
    };
  },
  "post /api/jobs/{id}/retry": async () => {
    const jobId = await createJob();
    // 📋 再実行は終了済みジョブだけが対象なので、完了を待ってから叩く（実行中の再実行は 409）。
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const job = (await call(`/api/jobs/${jobId}`)).body.job;
      if (
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "cancelled"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return {
      ...(await call(`/api/jobs/${jobId}/retry`, { method: "POST" })),
      expected: 202,
    };
  },
};

test("every documented operation responds and no operation is missing a probe", async () => {
  const spec = await fetchSpec();
  const documented = [];
  for (const [pathName, pathItem] of Object.entries(spec.paths)) {
    for (const method of Object.keys(pathItem))
      documented.push(`${method} ${pathName}`);
  }
  assert.ok(documented.length > 0);
  for (const key of documented) {
    assert.ok(
      probes[key],
      `missing contract probe for documented operation: ${key}`,
    );
  }
  for (const key of Object.keys(probes)) {
    assert.ok(
      documented.includes(key),
      `probe for undocumented operation: ${key}`,
    );
  }
  for (const key of documented) {
    const result = await probes[key]();
    assertRouteExists(result);
    assert.equal(
      result.status,
      result.expected,
      `${key} returned ${result.status}, expected ${result.expected}: ${result.text.slice(0, 200)}`,
    );
  }
});

test("error responses share one envelope with a request id", async () => {
  const cases = [
    await call("/api/run", {
      method: "POST",
      body: JSON.stringify({ message: "" }),
    }),
    await call("/api/recipes/no-such-recipe"),
    await call("/api/runs/no-such-run"),
    await call("/api/jobs/no-such-job"),
    await call("/api/workspace"),
  ];
  for (const result of cases) {
    assert.ok(
      result.status >= 400 && result.status < 500,
      `expected a 4xx error, got ${result.status}`,
    );
    assert.equal(typeof result.body?.error?.code, "string");
    assert.ok(result.body.error.code.length > 0);
    assert.equal(typeof result.body?.error?.message, "string");
    assert.ok(result.body.error.message.length > 0);
    assert.equal(typeof result.body?.requestId, "string");
    assert.equal(result.headers.get("x-request-id"), result.body.requestId);
  }
  assert.equal(cases[0].body.error.code, "INVALID_REQUEST");
  assert.equal(cases[4].body.error.code, "AUTH_REQUIRED");
});

test("success responses match their documented shape", async () => {
  const health = await call("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.status, "ok");
  assert.equal(health.body.service, "mojuleagent");
  assert.equal(typeof health.body.version, "string");
  assert.ok(["demo", "enabled"].includes(health.body.llm));

  const modules = await call("/api/modules");
  assert.equal(modules.status, 200);
  const moduleIds = new Set(modules.body.modules.map((module) => module.id));
  for (const module of modules.body.modules) {
    assert.equal(typeof module.id, "string");
    assert.equal(typeof module.name, "string");
    assert.equal(typeof module.version, "string");
    assert.ok(
      ["input", "knowledge", "reasoning", "transform", "output"].includes(
        module.category,
      ),
    );
    assert.equal(typeof module.description, "string");
    assert.ok(Array.isArray(module.inputs));
    assert.ok(Array.isArray(module.outputs));
  }
  assert.equal(modules.body.recipe.nodes.length, 3);
  for (const node of modules.body.recipe.nodes) {
    assert.ok(
      moduleIds.has(node.moduleId),
      `default recipe references unknown module: ${node.moduleId}`,
    );
  }

  const marketplace = await call("/api/marketplace");
  assert.equal(marketplace.status, 200);
  for (const module of marketplace.body.modules) {
    assert.equal(typeof module.author, "string");
    assert.equal(typeof module.license, "string");
    assert.ok(Array.isArray(module.tags));
    assert.equal(typeof module.repository, "string");
  }

  const ask = await call("/api/ask", {
    method: "POST",
    body: JSON.stringify({ message: "contract-shape" }),
  });
  assert.equal(ask.status, 200);
  assert.equal(ask.body.mode, "demo");
  assert.match(ask.body.answer, /contract-shape/);
  assert.ok(Array.isArray(ask.body.steps));
  assert.equal(typeof ask.body.steps[0].moduleId, "string");
  assert.equal(typeof ask.body.steps[0].durationMs, "number");
  assert.equal(typeof ask.body.runId, "string");
  assert.equal(typeof ask.body.createdAt, "string");
});

test("execution endpoints expose rate limit headers", async () => {
  const result = await call("/api/run", {
    method: "POST",
    body: JSON.stringify({ message: "" }),
  });
  assert.equal(result.status, 400);
  assert.equal(result.headers.get("x-ratelimit-limit"), "60");
  assert.match(result.headers.get("x-ratelimit-remaining") || "", /^\d+$/);
});

test("recipe validation rejects unknown modules and duplicate node ids", async () => {
  const unknown = await call("/api/recipes/validate", {
    method: "POST",
    body: JSON.stringify({
      ...recipe,
      nodes: [{ id: "x", moduleId: "no.such-module" }],
    }),
  });
  assert.equal(unknown.status, 422);
  assert.equal(unknown.body.valid, false);
  assert.match(unknown.body.issues[0], /unknown module/);

  const duplicate = await call("/api/recipes", {
    method: "POST",
    body: JSON.stringify({
      ...recipe,
      nodes: [
        { id: "same", moduleId: "input.message" },
        { id: "same", moduleId: "ai.respond" },
      ],
    }),
  });
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.body.error.code, "INVALID_RECIPE");
});

// 🔐 AUTH_REQUIRED=true のサーバーを別ポートで起動し、認証・RBACの境界を検証する。
// データファイルは一時ディレクトリに分離し、メインのサーバーと干渉させない。
describe("auth boundaries with AUTH_REQUIRED=true", () => {
  const authPort = "3001";
  const authBase = `http://127.0.0.1:${authPort}`;
  let server;
  let dataDir;

  async function authCall(pathname, options = {}) {
    const response = await fetch(`${authBase}${pathname}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, headers: response.headers, text, body };
  }

  const cookieOf = (result) =>
    result.headers.get("set-cookie")?.split(";", 1)[0];
  const uniqueEmail = (prefix) =>
    `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

  before(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "mojule-contract-"));
    server = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "server/index.ts"],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          PORT: authPort,
          NODE_ENV: "test",
          MOJULE_LLM_ENABLED: "false",
          AUTH_REQUIRED: "true",
          RECIPES_FILE: path.join(dataDir, "recipes.json"),
          RUN_HISTORY_FILE: path.join(dataDir, "runs.json"),
          AUTH_FILE: path.join(dataDir, "auth.json"),
        },
        windowsHide: true,
        // 🚀 tsxはラッパーが子プロセスを起動するため、SIGTERMだけでは子が残る。
        // プロセスグループごと終了させて取り残しを防ぐ（Windowsでは個別に終了）。
        detached: process.platform !== "win32",
      },
    );
    let ready = false;
    // ⏳ CIの冷えた環境では初回起動が遅いため、待ち時間は長めに取る（250ms × 120回＝30秒）。
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const response = await fetch(`${authBase}/api/health`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // ⏳ 起動待ち
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(ready, "AUTH_REQUIRED server did not start");
  });

  after(() => {
    if (!server) return;
    try {
      if (process.platform !== "win32") process.kill(-server.pid, "SIGKILL");
      else server.kill("SIGKILL");
    } catch {
      server.kill();
    }
  });

  test("protected reads and writes require login", async () => {
    for (const pathname of ["/api/recipes", "/api/runs", "/api/jobs"]) {
      const result = await authCall(pathname);
      assert.equal(result.status, 401, `${pathname} should require login`);
      assert.equal(result.body.error.code, "AUTH_REQUIRED");
    }
    const write = await authCall("/api/recipes", {
      method: "POST",
      body: JSON.stringify(recipe),
    });
    assert.equal(write.status, 401);
  });

  test("owner, editor, and viewer roles are enforced", async () => {
    const ownerEmail = uniqueEmail("contract-owner");
    const ownerRegistered = await authCall("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: ownerEmail,
        password: "owner-pass-123",
        name: "Owner",
      }),
    });
    assert.equal(ownerRegistered.status, 201);
    const ownerCookie = cookieOf(ownerRegistered);
    assert.ok(ownerCookie);

    const ownerRecipe = { ...recipe, id: "contract-owner-recipe" };
    const saved = await authCall("/api/recipes", {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: JSON.stringify(ownerRecipe),
    });
    assert.equal(saved.status, 201);

    const editorEmail = uniqueEmail("contract-editor");
    const invite = await authCall("/api/workspace/invitations", {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: JSON.stringify({
        email: editorEmail,
        name: "Editor",
        role: "editor",
      }),
    });
    assert.equal(invite.status, 201);
    const editorJoined = await authCall("/api/auth/accept-invite", {
      method: "POST",
      body: JSON.stringify({
        token: invite.body.invitation.token,
        password: "editor-pass-123",
      }),
    });
    assert.equal(editorJoined.status, 201);
    const editorCookie = cookieOf(editorJoined);

    const editorRecipe = { ...recipe, id: "contract-editor-recipe" };
    const editorSaved = await authCall("/api/recipes", {
      method: "POST",
      headers: { cookie: editorCookie },
      body: JSON.stringify(editorRecipe),
    });
    assert.equal(editorSaved.status, 201);
    const editorDelete = await authCall("/api/recipes/contract-owner-recipe", {
      method: "DELETE",
      headers: { cookie: editorCookie },
    });
    assert.equal(editorDelete.status, 403);
    assert.equal(editorDelete.body.error.code, "FORBIDDEN");

    const viewerEmail = uniqueEmail("contract-viewer");
    const viewerInvite = await authCall("/api/workspace/invitations", {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: JSON.stringify({
        email: viewerEmail,
        name: "Viewer",
        role: "viewer",
      }),
    });
    assert.equal(viewerInvite.status, 201);
    const viewerJoined = await authCall("/api/auth/accept-invite", {
      method: "POST",
      body: JSON.stringify({
        token: viewerInvite.body.invitation.token,
        password: "viewer-pass-123",
      }),
    });
    assert.equal(viewerJoined.status, 201);
    const viewerCookie = cookieOf(viewerJoined);
    const viewerRead = await authCall("/api/recipes", {
      headers: { cookie: viewerCookie },
    });
    assert.equal(viewerRead.status, 200);
    const viewerWrite = await authCall("/api/recipes", {
      method: "POST",
      headers: { cookie: viewerCookie },
      body: JSON.stringify({ ...recipe, id: "contract-viewer-recipe" }),
    });
    assert.equal(viewerWrite.status, 403);
    const viewerRuns = await authCall("/api/runs", {
      headers: { cookie: viewerCookie },
    });
    assert.equal(viewerRuns.status, 200);
  });

  test("execution endpoints /api/run and /api/ask also require login", async () => {
    for (const pathname of ["/api/run", "/api/ask"]) {
      const result = await authCall(pathname, {
        method: "POST",
        body: JSON.stringify({ message: "must not run" }),
      });
      assert.equal(result.status, 401, `${pathname} should require login`);
      assert.equal(result.body.error.code, "AUTH_REQUIRED");
    }
  });

  test("the workspace owner role cannot be changed", async () => {
    const ownerEmail = uniqueEmail("contract-sole-owner");
    const ownerRegistered = await authCall("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: ownerEmail,
        password: "owner-pass-123",
        name: "Sole Owner",
      }),
    });
    assert.equal(ownerRegistered.status, 201);
    const ownerCookie = cookieOf(ownerRegistered);
    const me = await authCall("/api/auth/me", {
      headers: { cookie: ownerCookie },
    });
    const demote = await authCall(`/api/workspace/members/${me.body.user.id}`, {
      method: "PATCH",
      headers: { cookie: ownerCookie },
      body: JSON.stringify({ role: "viewer" }),
    });
    assert.equal(demote.status, 400);
    assert.equal(demote.body.error.code, "OWNER_ROLE_CANNOT_CHANGE");
    const workspace = await authCall("/api/workspace", {
      headers: { cookie: ownerCookie },
    });
    assert.equal(workspace.body.user.role, "owner");
  });

  test("invited members see the workspace's stored name, not their own", async () => {
    const ownerEmail = uniqueEmail("contract-ws-owner");
    const ownerRegistered = await authCall("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: ownerEmail,
        password: "owner-pass-123",
        name: "Workspace Owner",
      }),
    });
    assert.equal(ownerRegistered.status, 201);
    const ownerCookie = cookieOf(ownerRegistered);
    const memberEmail = uniqueEmail("contract-ws-member");
    const invite = await authCall("/api/workspace/invitations", {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: JSON.stringify({
        email: memberEmail,
        name: "Member Name",
        role: "editor",
      }),
    });
    assert.equal(invite.status, 201);
    const joined = await authCall("/api/auth/accept-invite", {
      method: "POST",
      body: JSON.stringify({
        token: invite.body.invitation.token,
        password: "member-pass-123",
      }),
    });
    assert.equal(joined.status, 201);
    const memberCookie = cookieOf(joined);
    const workspace = await authCall("/api/workspace", {
      headers: { cookie: memberCookie },
    });
    assert.equal(workspace.status, 200);
    assert.equal(workspace.body.workspace.name, "Workspace Owner workspace");
  });

  test("api keys authenticate and stop working after revocation", async () => {
    const ownerEmail = uniqueEmail("contract-key-owner");
    const ownerRegistered = await authCall("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: ownerEmail,
        password: "key-owner-pass",
        name: "Key Owner",
      }),
    });
    assert.equal(ownerRegistered.status, 201);
    const ownerCookie = cookieOf(ownerRegistered);
    const created = await authCall("/api/workspace/api-keys", {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: JSON.stringify({ name: "Contract CLI" }),
    });
    assert.equal(created.status, 201);
    assert.match(created.body.token, /^mj_/);
    assert.equal(created.body.key.token, undefined);

    const workspace = await authCall("/api/workspace", {
      headers: { authorization: `Bearer ${created.body.token}` },
    });
    assert.equal(workspace.status, 200);
    const revoked = await authCall(
      `/api/workspace/api-keys/${created.body.key.id}`,
      {
        method: "DELETE",
        headers: { cookie: ownerCookie },
      },
    );
    assert.equal(revoked.status, 200);
    const rejected = await authCall("/api/workspace", {
      headers: { authorization: `Bearer ${created.body.token}` },
    });
    assert.equal(rejected.status, 401);
  });
});
