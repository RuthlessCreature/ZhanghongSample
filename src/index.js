const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const SYSTEM_PROMPT = `你是 Agent Hong 的建筑施工图版本变更审查引擎。
你的任务不是设计建筑，也不是替代注册建筑师或审图机构，而是比较用户提供的两版施工图页面，找出可观察到的版本变化、疑似未同步修改、以及需要人工复核的风险。

工作原则：
1. 只报告图中有视觉证据支持的变化，不要脑补看不清的尺寸、材料、规范结论。
2. 优先识别：墙体/门窗/轴网/尺寸/标高/房间名称/编号/文字说明/详图索引/构件位置/图框版本信息等变化。
3. 特别寻找“改了一处但相关视图、剖面、详图、文字说明可能仍旧”的疑似漏同步问题。
4. 如果无法确认，明确写“需人工复核”，并降低 confidence。
5. 输出必须是严格 JSON，不要 Markdown，不要代码围栏，不要在 JSON 前后加解释。
6. 所有文字字段使用简体中文。

JSON 结构：
{
  "summary": "一句话总结本次版本变化",
  "overall": "整体判断，强调最需要人看的地方",
  "counts": {"changed": 0, "highRisk": 0, "possibleMissedSync": 0},
  "changes": [
    {
      "id": "C01",
      "severity": "high|medium|low",
      "category": "墙体|门窗|轴网|尺寸|标高|文字|编号|构件|图框|其他",
      "location": "页码/轴网/房间/图号等可定位信息",
      "versionA": "A版可观察状态",
      "versionB": "B版可观察状态",
      "impact": "可能影响；不能确认时写需人工复核",
      "confidence": 0.0
    }
  ],
  "syncRisks": [
    {
      "id": "R01",
      "severity": "high|medium|low",
      "location": "位置",
      "issue": "疑似漏同步/前后不一致说明",
      "evidence": "图中证据",
      "confidence": 0.0
    }
  ],
  "verification": ["建议人工核查项1", "建议人工核查项2"]
}`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function dataUrlBytes(s) {
  if (typeof s !== "string") return 0;
  const i = s.indexOf(",");
  const b64 = i >= 0 ? s.slice(i + 1) : s;
  return Math.ceil((b64.length * 3) / 4);
}

function validatePayload(body) {
  if (!body || typeof body !== "object") return "请求体无效";
  for (const key of ["versionA", "versionB"]) {
    const v = body[key];
    if (!v || !Array.isArray(v.pages) || v.pages.length === 0) return `${key} 缺少图纸页面`;
    if (v.pages.length > 8) return `${key} 最多支持 8 页`;
    for (const p of v.pages) {
      if (typeof p !== "string" || !p.startsWith("data:image/")) return `${key} 页面格式无效`;
    }
  }
  const all = [...body.versionA.pages, ...body.versionB.pages];
  const total = all.reduce((n, p) => n + dataUrlBytes(p), 0);
  if (total > 28 * 1024 * 1024) return "图纸预处理后总大小超过 28MB，请减少页数或文件尺寸";
  return null;
}

function buildUserContent(body) {
  const content = [];
  content.push({
    type: "text",
    text: `项目：${body.projectName || "未填写"}\n补充说明：${body.notes || "无"}\n下面先给出 A 版，再给出 B 版。请逐页比较，并重点检查可能的漏同步修改。`
  });
  body.versionA.pages.forEach((url, idx) => {
    content.push({ type: "text", text: `A版｜${body.versionA.name || "版本A"}｜第 ${idx + 1} 页` });
    content.push({ type: "image_url", image_url: { url } });
  });
  body.versionB.pages.forEach((url, idx) => {
    content.push({ type: "text", text: `B版｜${body.versionB.name || "版本B"}｜第 ${idx + 1} 页` });
    content.push({ type: "image_url", image_url: { url } });
  });
  return content;
}

function stripJsonFence(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return s;
}

async function callMiniMax(env, body) {
  if (!env.MINIMAX_API_KEY) {
    throw new Error("服务端尚未配置 MINIMAX_API_KEY");
  }
  const base = (env.MINIMAX_API_BASE || "https://api.minimax.io/v1").replace(/\/$/, "");
  const model = env.MINIMAX_MODEL || "MiniMax-M3";
  const resp = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MINIMAX_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserContent(body) }
      ],
      temperature: 0.2,
      max_completion_tokens: 9000,
      reasoning_split: true,
      thinking: { type: "adaptive" }
    })
  });

  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`MiniMax API ${resp.status}: ${raw.slice(0, 500)}`);
  }

  let envelope;
  try { envelope = JSON.parse(raw); } catch { throw new Error("MiniMax 返回了非 JSON 响应"); }
  const content = envelope?.choices?.[0]?.message?.content;
  if (!content) throw new Error("MiniMax 未返回分析内容");

  // MiniMax M3 的 OpenAI-compatible 接口在部分多模态请求中会直接
  // 把结构化结果作为 object 放进 message.content，而不是 JSON 字符串。
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return { result: content, usage: envelope.usage || null, model };
  }

  // 兼容 content parts 数组，优先拼接 text；若某个 part 本身就是对象则直接使用。
  if (Array.isArray(content)) {
    const direct = content.find(x => x && typeof x === "object" && !("text" in x) && !("type" in x));
    if (direct) return { result: direct, usage: envelope.usage || null, model };
    const textContent = content.map(x => typeof x === "string" ? x : (x?.text || "")).join("").trim();
    try {
      return { result: JSON.parse(stripJsonFence(textContent)), usage: envelope.usage || null, model };
    } catch {}
  }

  try {
    return { result: JSON.parse(stripJsonFence(content)), usage: envelope.usage || null, model };
  } catch {
    return {
      result: {
        summary: "模型已完成分析，但结构化解析失败",
        overall: typeof content === "string" ? content : JSON.stringify(content),
        counts: { changed: 0, highRisk: 0, possibleMissedSync: 0 },
        changes: [], syncRisks: [], verification: ["请人工阅读上方模型原始结果"]
      },
      usage: envelope.usage || null,
      model,
      parseWarning: true
    };
  }
}

async function handleCompare(request, env) {
  const len = Number(request.headers.get("content-length") || "0");
  if (len > 38 * 1024 * 1024) return json({ error: "请求过大，最大 38MB" }, 413);
  let body;
  try { body = await request.json(); } catch { return json({ error: "请求 JSON 无效" }, 400); }
  const error = validatePayload(body);
  if (error) return json({ error }, 400);

  try {
    const out = await callMiniMax(env, body);
    return json({ ok: true, ...out });
  } catch (e) {
    console.error("compare_failed", e);
    return json({ error: e?.message || "分析失败" }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/smoke" || url.pathname === "/smoke.html") {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        product: "Agent Hong",
        feature: "drawing-version-diff",
        model: env.MINIMAX_MODEL || "MiniMax-M3",
        configured: Boolean(env.MINIMAX_API_KEY)
      });
    }
    if (url.pathname === "/api/compare" && request.method === "POST") {
      return handleCompare(request, env);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  }
};
