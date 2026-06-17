// Cloudflare Pages Function:  POST /api/kantei
// 役割: ブラウザからの鑑定リクエストを受け、サーバ側に隠したGeminiキーでGemini APIを呼ぶ。
//   - アクセスコード検証（環境変数 ACCESS_CODES のカンマ区切りリストと照合）
//   - モデルのフォールバック / 一時エラーの再試行 / MAX_TOKENS時の続き生成
// 必要な環境変数（Pages のプロジェクト設定 → 変数とシークレット）:
//   GEMINI_API_KEY  … 有料のGemini APIキー（シークレット推奨・必須）
//   ACCESS_CODES    … 例: "TETTUN-A1,KOKYAKU-7788,DEMO-0001"（必須。未設定なら全拒否）
//   GEMINI_MODEL    … 任意。既定 "gemini-2.5-flash"

const FALLBACK_MODELS = ["gemini-2.0-flash", "gemini-flash-latest", "gemini-2.5-flash-lite"];
const MAX_IMAGES = 9;
const MAX_CONTINUE = 3;
const MAX_ATTEMPTS = 3;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTransient = (m) =>
  /high demand|overload|unavailable|try again later|rate limit|resource has been exhausted|exhausted|\b429\b|\b503\b|\b500\b|internal error/i.test(m || "");
const isAuthErr = (m) =>
  /api key|api_key|permission.?denied|unauthorized|invalid.*(key|credential)|api key not valid/i.test(m || "");

function genCfg(model) {
  const is25 = /2\.5/.test(model);
  const cfg = { temperature: 0.7, maxOutputTokens: is25 ? 32768 : 8192 };
  if (is25) cfg.thinkingConfig = { thinkingBudget: 8192 };
  return cfg;
}

async function post(contents, model, key) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent?key=" +
    encodeURIComponent(key);
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, generationConfig: genCfg(model) }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || "HTTP " + r.status);
  const c = d.candidates && d.candidates[0];
  if (!c)
    throw new Error(
      "応答が空でした" +
        (d.promptFeedback && d.promptFeedback.blockReason ? "／" + d.promptFeedback.blockReason : "")
    );
  const txt = ((c.content && c.content.parts) || []).map((p) => p.text || "").join("");
  return { text: txt, finish: c.finishReason || "" };
}

async function callOnce(promptText, images, model, key) {
  const uparts = [{ text: promptText }];
  for (const im of images) {
    if (im.label) uparts.push({ text: "【写真：" + im.label + "】" });
    uparts.push({ inline_data: { mime_type: im.mime, data: im.b64 } });
  }
  const contents = [{ role: "user", parts: uparts }];
  let res = await post(contents, model, key);
  if (!res.text) throw new Error("テキスト応答なし（" + res.finish + "）");
  let out = res.text,
    tries = 0;
  while (res.finish === "MAX_TOKENS" && tries < MAX_CONTINUE) {
    tries++;
    contents.push({ role: "model", parts: [{ text: res.text }] });
    contents.push({
      role: "user",
      parts: [{ text: "直前の鑑定文の続きを、挨拶や重複を入れず途中から、最後（⑧総合評価100点満点）まで書き切ってください。" }],
    });
    res = await post(contents, model, key);
    out += res.text;
  }
  return out;
}

async function callGemini(promptText, images, primaryModel, key) {
  const models = [primaryModel];
  for (const m of FALLBACK_MODELS) if (!models.includes(m)) models.push(m);
  let lastErr;
  for (const model of models) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await callOnce(promptText, images, model, key);
      } catch (e) {
        lastErr = e;
        const msg = (e && e.message) || "";
        if (isAuthErr(msg)) throw e;
        if (isTransient(msg)) { await sleep(attempt * 1500); continue; }
        break;
      }
    }
  }
  throw lastErr || new Error("不明なエラー");
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.GEMINI_API_KEY) return json({ error: "サーバ未設定です（運営にご連絡ください）。" }, 500);
  const validCodes = String(env.ACCESS_CODES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (validCodes.length === 0) return json({ error: "現在ご利用いただけません（運営にご連絡ください）。" }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "リクエスト形式が不正です。" }, 400);
  }

  const code = String(body.code || "").trim();
  if (!code) return json({ error: "アクセスコードを入力してください。" }, 401);
  if (!validCodes.includes(code)) return json({ error: "アクセスコードが無効です。" }, 403);

  const prompt = String(body.prompt || "");
  if (!prompt) return json({ error: "鑑定内容が空です。" }, 400);

  let images = Array.isArray(body.images) ? body.images : [];
  images = images
    .filter((im) => im && im.b64 && im.mime)
    .slice(0, MAX_IMAGES)
    .map((im) => ({ mime: String(im.mime), b64: String(im.b64), label: String(im.label || "") }));

  const primaryModel = String(env.GEMINI_MODEL || "gemini-2.5-flash");

  try {
    const text = await callGemini(prompt, images, primaryModel, env.GEMINI_API_KEY);
    if (!text) return json({ error: "テキスト応答が空でした。少し時間をおいて再度お試しください。" }, 502);
    return json({ text });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (isAuthErr(msg)) return json({ error: "現在ご利用いただけません（運営側設定）。" }, 503);
    if (isTransient(msg))
      return json({ error: "ただいま混雑しています。1〜2分おいて再度お試しください。" }, 503);
    return json({ error: "鑑定に失敗しました：" + msg }, 502);
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method Not Allowed" }, 405);
}
