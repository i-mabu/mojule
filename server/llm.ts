// ==========================================
// 🤖 LLM 呼び出し
// ==========================================

import "dotenv/config";

const enabled = process.env.MOJULE_LLM_ENABLED === "true";
const apiKey = enabled ? process.env.OPENAI_API_KEY || "" : "";
const baseUrl = (
  process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
).replace(/\/$/, "");
const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
const parsedBaseUrl = new URL(baseUrl);
if (!["http:", "https:"].includes(parsedBaseUrl.protocol))
  throw new Error("OPENAI_BASE_URL must use http or https");
// 📌 キーが無ければ実際はデモモードで動くため、ヘルスチェック等の表示はこの値で判定する（MOJULE_LLM_ENABLED だけでは「enabled」と誤表示になる）。
export const llmEnabled = enabled && Boolean(apiKey);

export async function answer(
  message: string,
  signal?: AbortSignal,
): Promise<{ answer: string; mode: "demo" | "llm" }> {
  if (!apiKey)
    return {
      mode: "demo",
      answer: `デモモードです。MOJULE_LLM_ENABLED=trueとOPENAI_API_KEYを設定するとLLMへ接続します。\n\n入力：${message}`,
    };
  const signals = [AbortSignal.timeout(30_000)];
  if (signal) signals.push(signal);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    signal: AbortSignal.any(signals),
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "明確で役立つ日本語で回答してください。" },
        { role: "user", content: message },
      ],
    }),
  });
  if (!response.ok) throw new Error(`LLM request failed: ${response.status}`);
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLMから空の回答が返りました");
  return { mode: "llm", answer: content };
}
