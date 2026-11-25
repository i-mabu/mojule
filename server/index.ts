// ==========================================
// 🚀 API サーバー
// ==========================================

import "dotenv/config";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";
import { z } from "zod";
import { createServer } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  defaultRecipe,
  executeRecipe,
  listModules,
  validateRecipe,
} from "./modules";
import { searchMarketplace } from "./marketplace";
import { runRequestSchema } from "../shared/validation";
import { recipeIdSchema, recipeSaveSchema } from "../shared/validation";
import { recipes } from "./recipes";
import { runs } from "./runs";
import { jobs, type JobProgress, type JobRecord } from "./jobs";
import { auth, type User } from "./auth";
import {
  acceptInvitationSchema,
  apiKeySchema,
  invitationSchema,
  loginSchema,
  registerSchema,
  roleUpdateSchema,
} from "../shared/validation";
import { openapiDocument } from "./openapi";
import { llmEnabled } from "./llm";

const app = express();
const server = createServer(app);
const port = Number(process.env.PORT || 3000);
const version = process.env.npm_package_version || "0.1.0";
const requestCounts = new Map<string, { count: number; resetAt: number }>();
const authCounts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 60;
const AUTH_RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
// 🧹 期限切れバケットを定期的に掃除する（従来は同一IPが再訪するまで残り続け、IP数が増えるほどマップが肥大化していた）。
const rateLimitSweep = setInterval(() => {
  const now = Date.now();
  for (const store of [requestCounts, authCounts])
    for (const [key, bucket] of store)
      if (bucket.resetAt <= now) store.delete(key);
}, RATE_WINDOW_MS);
rateLimitSweep.unref?.();

if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be an integer between 1 and 65535");
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use((_req, res, next) => {
  const requestId = randomUUID();
  res.setHeader("x-request-id", requestId);
  res.locals.requestId = requestId;
  next();
});
app.use(express.json({ limit: "1mb", strict: true }));
app.use(async (req, res, next) => {
  try {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("mojule_session="));
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice("Bearer ".length).trim()
      : undefined;
    res.locals.user =
      (await auth.userFromApiKey(bearer)) ||
      (await auth.userFromToken(cookie?.slice("mojule_session=".length)));
    next();
  } catch (error) {
    next(error);
  }
});

function consumeLimit(
  store: Map<string, { count: number; resetAt: number }>,
  key: string,
) {
  const now = Date.now();
  const bucket = store.get(key);
  if (!bucket || bucket.resetAt <= now)
    store.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
  else bucket.count += 1;
  return store.get(key)!.count;
}

function rateLimit(req: Request, res: Response, next: NextFunction) {
  const count = consumeLimit(requestCounts, req.ip || "unknown");
  res.setHeader("x-ratelimit-limit", RATE_LIMIT);
  res.setHeader("x-ratelimit-remaining", Math.max(0, RATE_LIMIT - count));
  if (count > RATE_LIMIT)
    return res
      .status(429)
      .json({
        error: {
          code: "RATE_LIMITED",
          message: "リクエストが多すぎます。しばらく待ってください。",
        },
        requestId: res.locals.requestId,
      });
  next();
}

// 🔐 認証情報の試行（登録・ログイン・招待受諾）は総当たり対策として通常APIより厳しく制限する。
function authRateLimit(req: Request, res: Response, next: NextFunction) {
  const count = consumeLimit(authCounts, req.ip || "unknown");
  if (count > AUTH_RATE_LIMIT)
    return res
      .status(429)
      .json({
        error: {
          code: "RATE_LIMITED",
          message: "試行回数が多すぎます。しばらく待ってください。",
        },
        requestId: res.locals.requestId,
      });
  next();
}

function validateRun(
  req: Request,
  res: Response,
): z.infer<typeof runRequestSchema> | null {
  const parsed = runRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({
        error: {
          code: "INVALID_REQUEST",
          message: "入力内容を確認してください。",
          issues: parsed.error.issues,
        },
        requestId: res.locals.requestId,
      });
    return null;
  }
  return parsed.data;
}

function cookieOptions(maxAge: number) {
  return `Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
function setSession(res: Response, token: string) {
  res.setHeader(
    "set-cookie",
    `mojule_session=${token}; ${cookieOptions(7 * 24 * 60 * 60)}`,
  );
}
function requireUser(_req: Request, res: Response, next: NextFunction) {
  if (res.locals.user) return next();
  res
    .status(401)
    .json({
      error: { code: "AUTH_REQUIRED", message: "ログインが必要です。" },
      requestId: res.locals.requestId,
    });
}
function authRequired(req: Request, res: Response, next: NextFunction) {
  if (process.env.AUTH_REQUIRED !== "true") return next();
  requireUser(req, res, next);
}
function requireRole(...roles: User["role"][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (process.env.AUTH_REQUIRED !== "true") return next();
    if (!res.locals.user) return requireUser(req, res, next);
    const user = res.locals.user as User;
    if (!roles.includes(user.role))
      return res
        .status(403)
        .json({
          error: {
            code: "FORBIDDEN",
            message: "この操作を実行する権限がありません。",
            requiredRoles: roles,
          },
          requestId: res.locals.requestId,
        });
    next();
  };
}

async function executeAndRecord(
  recipe: z.infer<typeof recipeSaveSchema>,
  message: string,
  progress?: (value: JobProgress) => void,
  signal?: AbortSignal,
) {
  progress?.({
    percent: 50,
    stage: "running",
    message: "モジュールを実行しています",
  });
  const result = await executeRecipe(recipe, { text: message }, signal);
  // 📜 キャンセル済みなら実行履歴に残さない（中断された実行が通常の履歴として残ると履歴が汚染される）。
  if (signal?.aborted) throw new Error("Job cancelled");
  progress?.({
    percent: 90,
    stage: "recording",
    message: "実行結果を保存しています",
  });
  const record = await runs.create(recipe.id, message, result);
  return { ...result, runId: record.id, createdAt: record.createdAt };
}

// ------------------------------------------
// 💚 ヘルスチェック・仕様書
// ------------------------------------------
app.get("/api/health", (_req, res) =>
  res.json({
    status: "ok",
    service: "mojuleagent",
    version,
    llm: llmEnabled ? "enabled" : "demo",
  }),
);
app.get("/api/openapi.json", (_req, res) => res.json(openapiDocument));
app.get("/api/docs", (_req, res) => {
  const paths = Object.entries(openapiDocument.paths)
    .flatMap(([path, methods]) =>
      Object.keys(methods).map(
        (method) =>
          `<li><code>${method.toUpperCase()}</code> <span>${path}</span></li>`,
      ),
    )
    .join("");
  res
    .type("html")
    .send(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>mojuleagent API docs</title><style>body{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#18211b}h1{font-size:32px}code{background:#edf3e8;padding:3px 6px;border-radius:5px;font-size:12px}li{list-style:none;padding:9px;border-bottom:1px solid #e5ebe4}li code{display:inline-block;width:54px;text-align:center}a{color:#687e00}</style></head><body><h1>mojuleagent API</h1><p>OpenAPI 3.1 contract and endpoint index.</p><p><a href="/api/openapi.json">Download openapi.json</a></p><ul>${paths}</ul></body></html>`,
    );
});
// ------------------------------------------
// 🔐 認証 API
// ------------------------------------------
app.post("/api/auth/register", authRateLimit, async (req, res, next) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({
        error: {
          code: "INVALID_REGISTRATION",
          message: "メール、パスワード、名前を確認してください。",
          issues: parsed.error.issues,
        },
        requestId: res.locals.requestId,
      });
  try {
    const result = await auth.register(
      parsed.data.email,
      parsed.data.password,
      parsed.data.name,
    );
    setSession(res, result.token);
    res.status(201).json({ user: result.user });
  } catch (error) {
    if (error instanceof Error && error.message === "EMAIL_ALREADY_REGISTERED")
      return res
        .status(409)
        .json({
          error: {
            code: "EMAIL_ALREADY_REGISTERED",
            message: "このメールアドレスは登録済みです。",
          },
          requestId: res.locals.requestId,
        });
    next(error);
  }
});
app.post("/api/auth/login", authRateLimit, async (req, res, next) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({
        error: {
          code: "INVALID_LOGIN",
          message: "メールアドレスとパスワードを確認してください。",
        },
        requestId: res.locals.requestId,
      });
  try {
    const result = await auth.login(parsed.data.email, parsed.data.password);
    setSession(res, result.token);
    res.json({ user: result.user });
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_CREDENTIALS")
      return res
        .status(401)
        .json({
          error: {
            code: "INVALID_CREDENTIALS",
            message: "認証情報が正しくありません。",
          },
          requestId: res.locals.requestId,
        });
    next(error);
  }
});
app.post("/api/auth/logout", async (req, res, next) => {
  try {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("mojule_session="));
    await auth.logout(cookie?.slice("mojule_session=".length));
    res.setHeader("set-cookie", `mojule_session=; ${cookieOptions(0)}`);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
app.post("/api/auth/accept-invite", authRateLimit, async (req, res, next) => {
  const parsed = acceptInvitationSchema.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({
        error: {
          code: "INVALID_INVITATION",
          message: "招待トークンとパスワードを確認してください。",
        },
        requestId: res.locals.requestId,
      });
  try {
    const result = await auth.acceptInvite(
      parsed.data.token,
      parsed.data.password,
    );
    setSession(res, result.token);
    res.status(201).json({ user: result.user });
  } catch (error) {
    if (error instanceof Error && error.message === "INVITATION_NOT_FOUND")
      return res
        .status(404)
        .json({
          error: {
            code: "INVITATION_NOT_FOUND",
            message: "招待が見つからないか、有効期限が切れています。",
          },
          requestId: res.locals.requestId,
        });
    if (error instanceof Error && error.message === "EMAIL_ALREADY_REGISTERED")
      return res
        .status(409)
        .json({
          error: {
            code: "EMAIL_ALREADY_REGISTERED",
            message: "このメールアドレスは登録済みです。",
          },
          requestId: res.locals.requestId,
        });
    next(error);
  }
});
app.get("/api/auth/me", (_req, res) =>
  res.json({ user: (res.locals.user as User | null) || null }),
);
// ------------------------------------------
// 👥 ワークスペース API
// ------------------------------------------
app.get("/api/workspace", requireUser, async (_req, res, next) => {
  try {
    // 👥 ワークスペース名は保存済みの実名を返す
    // 閲覧者自身の名前から組み立てると、招待されたメンバーには別名に見えていた。
    const user = res.locals.user as User;
    const workspace = await auth.workspace(user.workspaceId);
    res.json({
      workspace: {
        id: user.workspaceId,
        name: workspace?.name || `${user.name} workspace`,
      },
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    next(error);
  }
});
app.get("/api/workspace/members", requireUser, async (_req, res, next) => {
  try {
    const user = res.locals.user as User;
    res.json({ members: await auth.members(user.workspaceId) });
  } catch (error) {
    next(error);
  }
});
app.post(
  "/api/workspace/invitations",
  requireRole("owner"),
  requireUser,
  async (req, res, next) => {
    const parsed = invitationSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({
          error: {
            code: "INVALID_INVITATION",
            message: "メール、名前、ロールを確認してください。",
            issues: parsed.error.issues,
          },
          requestId: res.locals.requestId,
        });
    try {
      const user = res.locals.user as User;
      // 🔐 招待トークンは開発環境でのみレスポンスに含める
      // README の前提どおり。本番ではメール配信アダプター経由で渡すため、生トークンを API レスポンスやログに残さない。
      const invitation = await auth.invite(
        user.workspaceId,
        parsed.data.email,
        parsed.data.name,
        parsed.data.role,
      );
      res
        .status(201)
        .json({
          invitation:
            process.env.NODE_ENV === "production"
              ? {
                  email: invitation.email,
                  name: invitation.name,
                  role: invitation.role,
                  expiresAt: invitation.expiresAt,
                }
              : invitation,
        });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "EMAIL_ALREADY_REGISTERED"
      )
        return res
          .status(409)
          .json({
            error: {
              code: "EMAIL_ALREADY_REGISTERED",
              message: "このメールアドレスは登録済みです。",
            },
            requestId: res.locals.requestId,
          });
      next(error);
    }
  },
);
app.patch(
  "/api/workspace/members/:id",
  requireRole("owner"),
  requireUser,
  async (req, res, next) => {
    const parsed = roleUpdateSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({
          error: {
            code: "INVALID_ROLE",
            message: "ロールを確認してください。",
          },
          requestId: res.locals.requestId,
        });
    try {
      const user = res.locals.user as User;
      const member = await auth.updateRole(
        user.workspaceId,
        String(req.params.id),
        parsed.data.role,
      );
      if (!member)
        return res
          .status(404)
          .json({
            error: {
              code: "MEMBER_NOT_FOUND",
              message: "メンバーが見つかりません。",
            },
            requestId: res.locals.requestId,
          });
      res.json({ member });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "OWNER_ROLE_CANNOT_CHANGE"
      )
        return res
          .status(400)
          .json({
            error: {
              code: "OWNER_ROLE_CANNOT_CHANGE",
              message: "オーナーのロールは変更できません。",
            },
            requestId: res.locals.requestId,
          });
      next(error);
    }
  },
);
app.delete(
  "/api/workspace/members/:id",
  requireRole("owner"),
  requireUser,
  async (req, res, next) => {
    try {
      const user = res.locals.user as User;
      if (String(req.params.id) === user.id)
        return res
          .status(400)
          .json({
            error: {
              code: "OWNER_CANNOT_REMOVE_SELF",
              message: "オーナー自身は削除できません。",
            },
            requestId: res.locals.requestId,
          });
      if (!(await auth.remove(user.workspaceId, String(req.params.id))))
        return res
          .status(404)
          .json({
            error: {
              code: "MEMBER_NOT_FOUND",
              message: "メンバーが見つかりません。",
            },
            requestId: res.locals.requestId,
          });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);
app.get(
  "/api/workspace/api-keys",
  requireRole("owner"),
  requireUser,
  async (_req, res, next) => {
    try {
      const user = res.locals.user as User;
      res.json({ keys: await auth.listApiKeys(user.workspaceId) });
    } catch (error) {
      next(error);
    }
  },
);
app.post(
  "/api/workspace/api-keys",
  requireRole("owner"),
  requireUser,
  async (req, res, next) => {
    const parsed = apiKeySchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({
          error: {
            code: "INVALID_API_KEY",
            message: "APIキー名を確認してください。",
          },
          requestId: res.locals.requestId,
        });
    try {
      const user = res.locals.user as User;
      const result = await auth.createApiKey(
        user.workspaceId,
        parsed.data.name,
      );
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  },
);
app.delete(
  "/api/workspace/api-keys/:id",
  requireRole("owner"),
  requireUser,
  async (req, res, next) => {
    try {
      const user = res.locals.user as User;
      const key = await auth.revokeApiKey(
        user.workspaceId,
        String(req.params.id),
      );
      if (!key)
        return res
          .status(404)
          .json({
            error: {
              code: "API_KEY_NOT_FOUND",
              message: "APIキーが見つかりません。",
            },
            requestId: res.locals.requestId,
          });
      res.json({ key });
    } catch (error) {
      next(error);
    }
  },
);
// ------------------------------------------
// 🧩 モジュール・マーケットプレイス
// ------------------------------------------
app.get("/api/modules", (_req, res) =>
  res.json({ modules: listModules(), recipe: defaultRecipe }),
);
app.get("/api/marketplace", (req, res) =>
  res.json({
    modules: searchMarketplace(
      typeof req.query.q === "string" ? req.query.q : "",
      typeof req.query.category === "string" ? req.query.category : "",
    ),
  }),
);
// ------------------------------------------
// 📖 レシピ・実行・ジョブ API
// ------------------------------------------
app.use(["/api/recipes", "/api/runs", "/api/jobs"], authRequired);
app.post("/api/recipes/validate", (req, res) => {
  const parsed = recipeSaveSchema.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({
        valid: false,
        issues: parsed.error.issues,
        requestId: res.locals.requestId,
      });
  const issues = validateRecipe(parsed.data);
  res
    .status(issues.length ? 422 : 200)
    .json({
      valid: issues.length === 0,
      issues,
      requestId: res.locals.requestId,
    });
});
app.get("/api/runs", async (req, res, next) => {
  try {
    res.json({
      runs: await runs.list(
        typeof req.query.recipeId === "string" ? req.query.recipeId : undefined,
      ),
    });
  } catch (error) {
    next(error);
  }
});
app.get("/api/runs/:id", async (req, res, next) => {
  try {
    const run = await runs.get(req.params.id);
    if (!run)
      return res
        .status(404)
        .json({
          error: {
            code: "RUN_NOT_FOUND",
            message: "実行履歴が見つかりません。",
          },
          requestId: res.locals.requestId,
        });
    res.json({ run });
  } catch (error) {
    next(error);
  }
});
app.get("/api/jobs", (_req, res) => res.json({ jobs: jobs.list() }));
app.get("/api/jobs/:id/events", (req, res) => {
  const job = jobs.get(String(req.params.id));
  if (!job)
    return res
      .status(404)
      .json({
        error: { code: "JOB_NOT_FOUND", message: "ジョブが見つかりません。" },
        requestId: res.locals.requestId,
      });
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  const send = (next: JobRecord) => {
    const { recipe: _recipe, ...publicJob } = next;
    res.write(`data: ${JSON.stringify(publicJob)}\n\n`);
  };
  const unsubscribe = jobs.subscribe(String(req.params.id), send);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});
app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job)
    return res
      .status(404)
      .json({
        error: { code: "JOB_NOT_FOUND", message: "ジョブが見つかりません。" },
        requestId: res.locals.requestId,
      });
  res.json({ job });
});
app.post("/api/jobs", rateLimit, (req, res) => {
  const parsed = validateRun(req, res);
  if (!parsed) return;
  const job = jobs.enqueue(
    parsed.recipe || defaultRecipe,
    parsed.message,
    executeAndRecord,
  );
  res.status(202).json({ job });
});
app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = jobs.cancel(req.params.id);
  if (!job)
    return res
      .status(404)
      .json({
        error: { code: "JOB_NOT_FOUND", message: "ジョブが見つかりません。" },
        requestId: res.locals.requestId,
      });
  res.json({ job });
});
app.post("/api/jobs/:id/retry", rateLimit, (req, res) => {
  const existing = jobs.get(String(req.params.id));
  if (!existing)
    return res
      .status(404)
      .json({
        error: { code: "JOB_NOT_FOUND", message: "ジョブが見つかりません。" },
        requestId: res.locals.requestId,
      });
  if (existing.status === "queued" || existing.status === "running")
    return res
      .status(409)
      .json({
        error: {
          code: "JOB_STILL_ACTIVE",
          message: "実行中または待機中のジョブは再実行できません。",
        },
        requestId: res.locals.requestId,
      });
  const job = jobs.retry(String(req.params.id), executeAndRecord);
  if (!job)
    return res
      .status(409)
      .json({
        error: {
          code: "JOB_STILL_ACTIVE",
          message: "実行中または待機中のジョブは再実行できません。",
        },
        requestId: res.locals.requestId,
      });
  res.status(202).json({ job });
});
app.get("/api/recipes", async (_req, res, next) => {
  try {
    res.json({ recipes: await recipes.list() });
  } catch (error) {
    next(error);
  }
});
app.get("/api/recipes/:id", async (req, res, next) => {
  const id = recipeIdSchema.safeParse(req.params.id);
  if (!id.success)
    return res
      .status(400)
      .json({
        error: { code: "INVALID_RECIPE_ID", message: "不正なレシピIDです。" },
        requestId: res.locals.requestId,
      });
  try {
    const recipe = await recipes.get(id.data);
    if (!recipe)
      return res
        .status(404)
        .json({
          error: {
            code: "RECIPE_NOT_FOUND",
            message: "レシピが見つかりません。",
          },
          requestId: res.locals.requestId,
        });
    res.json({ recipe });
  } catch (error) {
    next(error);
  }
});
app.post(
  "/api/recipes",
  requireRole("owner", "editor"),
  async (req, res, next) => {
    const parsed = recipeSaveSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({
          error: {
            code: "INVALID_RECIPE",
            message: "レシピ形式を確認してください。",
            issues: parsed.error.issues,
          },
          requestId: res.locals.requestId,
        });
    const issues = validateRecipe(parsed.data);
    if (issues.length)
      return res
        .status(422)
        .json({
          error: {
            code: "INVALID_RECIPE_CONNECTIONS",
            message: "モジュールの接続を確認してください。",
            issues,
          },
          requestId: res.locals.requestId,
        });
    try {
      res.status(201).json({ recipe: await recipes.save(parsed.data) });
    } catch (error) {
      next(error);
    }
  },
);
app.put(
  "/api/recipes/:id",
  requireRole("owner", "editor"),
  async (req, res, next) => {
    const id = recipeIdSchema.safeParse(req.params.id);
    if (!id.success)
      return res
        .status(400)
        .json({
          error: {
            code: "INVALID_RECIPE_ID",
            message: "不正なレシピIDです。",
            issues: id.error.issues,
          },
          requestId: res.locals.requestId,
        });
    const parsed = recipeSaveSchema.safeParse({
      ...req.body,
      id: req.params.id,
    });
    if (!parsed.success)
      return res
        .status(400)
        .json({
          error: {
            code: "INVALID_RECIPE",
            message: "レシピ形式を確認してください。",
            issues: parsed.error.issues,
          },
          requestId: res.locals.requestId,
        });
    const issues = validateRecipe(parsed.data);
    if (issues.length)
      return res
        .status(422)
        .json({
          error: {
            code: "INVALID_RECIPE_CONNECTIONS",
            message: "モジュールの接続を確認してください。",
            issues,
          },
          requestId: res.locals.requestId,
        });
    try {
      res.json({ recipe: await recipes.save(parsed.data) });
    } catch (error) {
      next(error);
    }
  },
);
app.delete("/api/recipes/:id", requireRole("owner"), async (req, res, next) => {
  const id = recipeIdSchema.safeParse(req.params.id);
  if (!id.success)
    return res
      .status(400)
      .json({
        error: { code: "INVALID_RECIPE_ID", message: "不正なレシピIDです。" },
        requestId: res.locals.requestId,
      });
  try {
    if (!(await recipes.delete(id.data)))
      return res
        .status(404)
        .json({
          error: {
            code: "RECIPE_NOT_FOUND",
            message: "レシピが見つかりません。",
          },
          requestId: res.locals.requestId,
        });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
app.post("/api/recipes/:id/run", rateLimit, async (req, res, next) => {
  const id = recipeIdSchema.safeParse(req.params.id);
  const parsed = runRequestSchema.safeParse(req.body);
  if (!id.success || !parsed.success)
    return res
      .status(400)
      .json({
        error: {
          code: "INVALID_REQUEST",
          message: "レシピIDまたは入力内容を確認してください。",
        },
        requestId: res.locals.requestId,
      });
  try {
    const recipe = await recipes.get(id.data);
    if (!recipe)
      return res
        .status(404)
        .json({
          error: {
            code: "RECIPE_NOT_FOUND",
            message: "レシピが見つかりません。",
          },
          requestId: res.locals.requestId,
        });
    res.json(await executeAndRecord(recipe, parsed.data.message));
  } catch (error) {
    next(error);
  }
});
// 🔐 /api/run と /api/ask も実行系APIであり、AUTH_REQUIRED=true では認証対象に含める（従来は対象外で、未ログインでも LLM 実行と履歴書き込みができていた）。
app.post("/api/run", authRequired, rateLimit, async (req, res, next) => {
  const parsed = validateRun(req, res);
  if (!parsed) return;
  try {
    res.json(
      await executeAndRecord(parsed.recipe || defaultRecipe, parsed.message),
    );
  } catch (error) {
    next(error);
  }
});
app.post("/api/ask", authRequired, rateLimit, async (req, res, next) => {
  const parsed = validateRun(req, res);
  if (!parsed) return;
  try {
    const result = await executeAndRecord(defaultRecipe, parsed.message);
    res.json({
      answer: result.output.markdown,
      mode: result.mode,
      steps: result.steps,
      runId: result.runId,
      createdAt: result.createdAt,
    });
  } catch (error) {
    next(error);
  }
});

// 📡 未定義の /api/* は SPA フォールバックや Vite に渡さず、JSON の 404 を返す（従来は本番・開発とも HTML の index が 200 で返り、API クライアントが判別できなかった）。
app.use("/api", (_req, res) =>
  res
    .status(404)
    .json({
      error: {
        code: "NOT_FOUND",
        message: "APIエンドポイントが見つかりません。",
      },
      requestId: res.locals.requestId,
    }),
);

if (process.env.NODE_ENV !== "production") {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: path.resolve(process.cwd(), "client"),
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  const dist = path.resolve(process.cwd(), "dist/public");
  app.use(express.static(dist, { maxAge: "1h", index: "index.html" }));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message =
    error instanceof Error ? error.message : "サーバーエラーが発生しました";
  // ⚠️ express.json 等が付けた HTTP ステータス（不正な JSON の 400、サイズ超過の 413）はそのまま尊重する。従来は全て 502 UPSTREAM_ERROR になり、クライアント起因のエラーを判別できなかった。
  const carried = (error as { status?: unknown } | null)?.status;
  if (typeof carried === "number" && carried >= 400 && carried < 500)
    return res
      .status(carried)
      .json({
        error: {
          code: carried === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST",
          message:
            carried === 413
              ? "リクエストが大きすぎます。"
              : "リクエスト形式を確認してください。",
        },
        requestId: res.locals.requestId,
      });
  // ⚠️ executeRecipe の検証エラーは "Invalid recipe: ..." で始まる。従来の "Unknown module" 判定だけでは到達不能で、不正なレシピも 502 になっていた。
  const status =
    message.startsWith("Unknown module") || message.startsWith("Invalid recipe")
      ? 400
      : 502;
  res
    .status(status)
    .json({
      error: {
        code: status === 400 ? "INVALID_RECIPE" : "UPSTREAM_ERROR",
        message,
      },
      requestId: res.locals.requestId,
    });
});

server.requestTimeout = 35_000;
server.headersTimeout = 40_000;
server.listen(port, "0.0.0.0", () =>
  console.log(`mojuleagent listening on http://localhost:${port}`),
);

function shutdown(signal: string) {
  console.log(`${signal}: shutting down`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
