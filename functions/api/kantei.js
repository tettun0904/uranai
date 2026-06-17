// Cloudflare Pages Function: POST /api/kantei
// 環境変数: GEMINI_API_KEY(必須) / ACCESS_CODES(必須・カンマ区切り) / GEMINI_MODEL(任意)

const MAX_IMAGES = 9;

function json(o, s = 200) {
  return new Response(JSON.stringify(o), {
    status: s,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function callGemini(prompt, images, model, key) {
  const parts = [{ text: prompt }];
  for (const im of images) {
    if (im.label) parts.push({ text: "【写真：" + im.label + "】" });
    parts.push({ inline_data: { mime_type: im.mime, data: im.b64 } });
  }
  const is25 = /2\.5/.test(model);
  const generationConfig = { temperature: 0.7, maxOutputTokens: is25 ? 32768 : 8192 };
  if (is25) generationConfig.thinkingConfig = { thinkingBudget: 8192 };
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key);
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || ("HTTP " + r.status));
  const c = d.candidates && d.candidates[0];
  const txt = c ? ((c.content && c.content.parts) || []).map((p) => p.text || "").join("") : "";
  if (!txt) throw new Error("応答が空でした");
  return txt;
}

export async function onRequestPost({ request, env }) {
  if (!env.GEMINI_API_KEY) return json({ error: "サーバ未設定です。" }, 500);
  const codes = String(env.ACCESS_CODES || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!codes.length) return json({ error: "現在ご利用いただけません。" }, 503);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "リクエスト形式が不正です。" }, 400); }

  const code = String(body.code || "").trim();
  if (!code) return json({ error: "アクセスコードを入力してください。" }, 401);
  if (!codes.includes(code)) return json({ error: "アクセスコードが無効です。" }, 403);

  const prompt = String(body.prompt || "");
  if (!prompt) return json({ error: "鑑定内容が空です。" }, 400);

  let images = Array.isArray(body.images) ? body.images : [];
  images = images.filter((im) => im && im.b64 && im.mime).slice(0, MAX_IMAGES)
    .map((im) => ({ mime: String(im.mime), b64: String(im.b64), label: String(im.label || "") }));

  const model = String(env.GEMINI_MODEL || "gemini-2.5-flash");
  try {
    const text = await callGemini(prompt, images, model, env.GEMINI_API_KEY);
    return json({ text });
  } catch (e) {
    return json({ error: "鑑定に失敗しました：" + ((e && e.message) || String(e)) }, 502);
  }
}
