// BiliDigest 收藏夹分拣台 background 层。classic script，由 background.js 末尾 importScripts 加载，
// 与 background.js 共享全局作用域，所以顶层名字统一带 triage / TRIAGE_ 前缀。
// 纯函数放顶部（selftest 用 vm 加载，chrome 为 undefined）。

// ===== 纯函数 =====

function triageMd5(str) {
  const bytes = new TextEncoder().encode(String(str));
  const len = bytes.length;
  const blocks = ((len + 8) >> 6) + 1;
  const m = new Uint32Array(blocks * 16);
  for (let i = 0; i < len; i++) m[i >> 2] |= bytes[i] << ((i % 4) * 8);
  m[len >> 2] |= 0x80 << ((len % 4) * 8);
  m[blocks * 16 - 2] = (len * 8) >>> 0;
  m[blocks * 16 - 1] = Math.floor((len * 8) / 4294967296);
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = [];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < m.length; off += 16) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const s = S[(i >> 4) * 4 + (i % 4)];
      F = (F + A + K[i] + m[off + g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  let hex = "";
  for (const w of [a0, b0, c0, d0]) {
    for (let i = 0; i < 4; i++) hex += ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

const TRIAGE_MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

function triageMixinKey(imgUrl, subUrl) {
  const key = (u) => String(u).split("/").pop().split(".")[0];
  const raw = key(imgUrl) + key(subUrl);
  return TRIAGE_MIXIN_TAB.map((i) => raw[i]).join("").slice(0, 32);
}

// 返回带 wts 与 w_rid 的完整 query string
function triageWbiSign(params, mixinKey, wts) {
  const all = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ""))}`)
    .join("&");
  return `${query}&w_rid=${triageMd5(query + mixinKey)}`;
}

// 优先人工字幕，其次 ai-zh
function triagePickTrack(subtitles) {
  const list = Array.isArray(subtitles) ? subtitles.filter((t) => t && t.subtitle_url) : [];
  return list.find((t) => !String(t.lan).startsWith("ai-")) || list.find((t) => t.lan === "ai-zh") || null;
}

// 防止拿到别的视频的字幕：最后一句结束时间要落在 [dur*0.5, dur+10]
function triageSubtitleValid(body, dur) {
  if (!Array.isArray(body) || !body.length || !(dur > 0)) return false;
  const lastTo = Number(body[body.length - 1].to);
  return lastTo <= dur + 10 && lastTo >= dur * 0.5;
}

function triageClip(text) {
  const s = String(text || "");
  return s.length > 12000 ? `${s.slice(0, 8000)}……${s.slice(-4000)}` : s;
}

// 从模型输出里取第一个完整的 {...} 或 [...]（去掉 ``` 围栏，跳过字符串里的括号）
function triageExtractJson(content, open) {
  const close = open === "[" ? "]" : "}";
  const s = String(content || "").replace(/```(?:json)?/gi, "");
  const start = s.indexOf(open);
  if (start < 0) throw new Error("AI 返回内容不是 JSON");
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error("AI 返回的 JSON 不完整");
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    throw new Error("AI 返回的 JSON 无法解析");
  }
}

function triageVerdict(v) {
  const s = String(v || "").trim().toLowerCase();
  return ["keep", "drop", "unsure"].includes(s) ? s : "unsure";
}

// 只保留列表内的标签，外加至多一个 "新:" 前缀的新标签，总数 ≤ max
function triageCoerceTags(raw, tags, max) {
  const allowed = new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).trim()));
  const out = [];
  let hasNew = false;
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= max) break;
    const t = String(item ?? "").trim();
    if (!t || out.includes(t)) continue;
    if (/^新[:：]/.test(t)) {
      const name = t.replace(/^新[:：]\s*/, "");
      if (!hasNew && name) { out.push(`新:${name}`); hasNew = true; }
    } else if (allowed.has(t)) {
      out.push(t);
    }
  }
  return out;
}

function triageParseLlm(content, tags) {
  const obj = triageExtractJson(content, "{");
  const oneLiner = String(obj.one_liner ?? obj.oneLiner ?? "").trim();
  if (!oneLiner) throw new Error("AI 返回缺少 one_liner");
  const points = (Array.isArray(obj.points) ? obj.points : [])
    .map((p) => String(p ?? "").trim())
    .filter(Boolean)
    .slice(0, 3);
  while (points.length < 3) points.push("");
  return {
    oneLiner,
    points,
    verdict: triageVerdict(obj.verdict),
    reason: String(obj.reason ?? "").trim(),
    suggestedTags: triageCoerceTags(obj.tags ?? obj.suggestedTags, tags, 3)
  };
}

// items 与发给模型的序号一一对应（序号从 1 开始）
function triageParseTitleBatch(content, items, tags) {
  const arr = triageExtractJson(content, "[");
  const byIndex = new Map();
  for (const r of Array.isArray(arr) ? arr : []) {
    const i = Number(r?.i);
    if (Number.isInteger(i) && !byIndex.has(i)) byIndex.set(i, r);
  }
  const results = {};
  items.forEach((item, idx) => {
    const r = byIndex.get(idx + 1);
    results[item.bvid] = r
      ? {
          verdict: triageVerdict(r.verdict),
          reason: String(r.reason ?? "").trim(),
          suggestedTags: triageCoerceTags(r.tags, tags, 2),
          confidence: String(r.confidence || "").trim().toLowerCase() === "high" ? "high" : "low"
        }
      : { verdict: "unsure", reason: "AI 未返回", suggestedTags: [], confidence: "low" };
  });
  return results;
}

function triageTitleLine(item, n) {
  const clean = (s) => String(s ?? "").replace(/[|\r\n]+/g, " ").trim();
  const d = Number(item.duration) || 0;
  const dur = `${Math.floor(d / 60)}:${String(d % 60).padStart(2, "0")}`;
  return `${n}|${clean(item.title)}|${clean(item.upper)}|${dur}|${clean(item.intro).slice(0, 60)}`;
}

function triageForm(obj) {
  return new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, String(v)])).toString();
}

const TRIAGE_SYSTEM_PROMPT = [
  "你是 B 站收藏夹分拣助手。根据给出的视频信息判断这个收藏值不值得留。",
  "只输出严格 JSON，不要任何其他文字、不要代码块：",
  '{"one_liner": "一句话说清视频讲了什么，≤40字", "points": ["要点1", "要点2", "要点3"], "verdict": "keep|drop|unsure", "reason": "判断理由，≤30字", "tags": ["标签"]}',
  "verdict 标准：",
  "- keep：有具体、可复用的知识、方法或数据。",
  "- drop：标题党、空谈、纯娱乐、过时新闻，或内容主要是广告。",
  "- unsure：其他情况，或信息太少无法判断（只有标题简介且简介很短时倾向 unsure）。",
  "tags：从给定的标签列表中选 0-3 个；都不合适时可以加至多一个新标签，写成 \"新:标签名\"。"
].join("\n");

const TRIAGE_TITLE_PROMPT = [
  "你是 B 站收藏夹分拣助手。下面每行是一个收藏的视频，格式：序号|标题|UP主|时长|简介前60字。",
  "只根据这些信息做初筛。标题是很弱的证据：看不出实际内容时，verdict 用 unsure，confidence 用 low，不要猜。",
  "verdict 标准：keep = 明显有具体、可复用的知识、方法或数据；drop = 明显是标题党、空谈、纯娱乐、过时新闻或广告；unsure = 其他情况。",
  "confidence：只有标题和简介足以判断时才用 high，否则用 low。",
  "tags：从给定的标签列表中选 0-2 个；都不合适时可以加至多一个新标签，写成 \"新:标签名\"。",
  "只输出严格 JSON 数组，每个视频一项，不要任何其他文字、不要代码块：",
  '[{"i": 序号, "verdict": "keep|drop|unsure", "reason": "≤20字", "tags": ["标签"], "confidence": "high|low"}]'
].join("\n");

function triageWithCriteria(system, criteria) {
  return criteria && String(criteria).trim() ? `${system}\n\n用户补充的判断标准：\n${String(criteria).trim()}` : system;
}

function triageTagListText(tags) {
  const list = (Array.isArray(tags) ? tags : []).map((t) => String(t).trim()).filter(Boolean);
  return `可选标签：${list.length ? list.join("、") : "（无）"}`;
}

function triageBuildMessages(meta, source, text, criteria, tags) {
  const system = `${triageWithCriteria(TRIAGE_SYSTEM_PROMPT, criteria)}\n\n${triageTagListText(tags)}`;
  const user = [
    `标题：${meta.title}`,
    `UP主：${meta.upper}`,
    `分区：${meta.tname || "未知"}`,
    `时长：${Math.round((meta.duration || 0) / 60)} 分钟`,
    `标签：${meta.tags.join("、") || "无"}`,
    `简介：${meta.desc || "无"}`,
    source === "subtitle" ? `\n字幕：\n${text}` : `\n（无可用字幕）\n热门评论：\n${text || "无"}`
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

// ===== chrome 相关 =====

function triageError(error, code) {
  return Object.assign(new Error(error), code ? { code } : {});
}

async function triageBiliGet(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw triageError(`B站请求失败 HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) throw triageError(`B站返回 ${json.code}: ${json.message}`, json.code === -352 || json.code === -412 ? "THROTTLED" : undefined);
  return json.data;
}

async function triageBiliPost(path, fields) {
  const cookie = await chrome.cookies.get({ url: "https://www.bilibili.com", name: "bili_jct" });
  if (!cookie?.value) throw triageError("未登录 B 站（缺少 csrf）");
  const res = await fetch(`https://api.bilibili.com${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: triageForm({ ...fields, csrf: cookie.value })
  });
  if (!res.ok) throw triageError(`B站请求失败 HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) throw triageError(`B站返回 ${json.code}: ${json.message}`);
  return json.data;
}

// nav 未登录时 code=-101 但 data.wbi_img 仍在，所以不走 triageBiliGet
async function triageNav() {
  const res = await fetch("https://api.bilibili.com/x/web-interface/nav", { credentials: "include" });
  return (await res.json()).data || {};
}

async function triageMid() {
  const nav = await triageNav();
  if (!nav.isLogin || !nav.mid) throw triageError("未登录 B 站");
  return nav.mid;
}

let triageMixinCache = { key: "", at: 0 };
async function triageGetMixinKey() {
  if (triageMixinCache.key && Date.now() - triageMixinCache.at < 10 * 60 * 1000) return triageMixinCache.key;
  const img = (await triageNav()).wbi_img;
  if (!img?.img_url) throw triageError("获取 WBI 签名密钥失败");
  triageMixinCache = { key: triageMixinKey(img.img_url, img.sub_url), at: Date.now() };
  return triageMixinCache.key;
}

async function triageCreatedFolders() {
  const mid = await triageMid();
  const data = await triageBiliGet(`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`);
  return { mid, folders: (data?.list || []).map((f) => ({ id: f.id, title: f.title, count: f.media_count })) };
}

const TRIAGE_SETTINGS_DEFAULTS = {
  triageCriteria: "",
  triageIntervalSec: 8,
  triageExportFolder: "raw/01-articles",
  triageTitleBatchSize: 30,
  triageThinking: false,
  triageTitleMaxTokens: 0,
  triageAnalyzeMaxTokens: 0
};

// 输出上限：用户填了正数就用用户的，否则按是否思考自动（思考 token 计入 max_tokens）
function triageMaxTokens(kind, itemCount, { triageThinking, triageTitleMaxTokens, triageAnalyzeMaxTokens }) {
  const custom = Number(kind === "title" ? triageTitleMaxTokens : triageAnalyzeMaxTokens);
  if (custom > 0) return Math.floor(custom);
  if (kind === "title") return triageThinking ? 150 * itemCount + 4000 : 60 * itemCount + 200;
  return triageThinking ? 8000 : 1000;
}

async function triageAiSettings() {
  const s = await chrome.storage.sync.get({ triageThinking: false, triageTitleMaxTokens: 0, triageAnalyzeMaxTokens: 0 });
  return { triageThinking: s.triageThinking === true, triageTitleMaxTokens: Number(s.triageTitleMaxTokens) || 0, triageAnalyzeMaxTokens: Number(s.triageAnalyzeMaxTokens) || 0 };
}

async function triageAnalyze({ bvid, force, tags }) {
  if (!bvid) throw triageError("缺少 bvid");
  const cacheKey = `triage_analysis_${bvid}`;
  if (!force) {
    const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
    if (cached) return cached;
  }

  const v = await triageBiliGet(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  const dur = v.pages?.[0]?.duration || v.duration || 0;
  const videoTags = await triageBiliGet(`https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`)
    .then((d) => (d || []).map((t) => t.tag_name).filter(Boolean))
    .catch(() => []);
  const meta = { title: v.title, desc: v.desc, upper: v.owner?.name || "", duration: dur, tname: v.tname, tags: videoTags };

  // 字幕：只用 WBI 签名的 wbi/v2
  const mixinKey = await triageGetMixinKey();
  const query = triageWbiSign({ aid: v.aid, cid: v.cid, bvid }, mixinKey, Math.floor(Date.now() / 1000));
  const player = await triageBiliGet(`https://api.bilibili.com/x/player/wbi/v2?${query}`);
  if (!player?.subtitle) throw triageError("B站字幕接口限流，稍后重试", "THROTTLED");

  let source = "meta";
  let text = "";
  const track = triagePickTrack(player.subtitle.subtitles);
  if (track) {
    const url = track.subtitle_url.startsWith("//") ? `https:${track.subtitle_url}` : track.subtitle_url;
    const body = await fetch(url).then((r) => r.json()).then((j) => j.body).catch(() => null);
    if (triageSubtitleValid(body, dur)) {
      source = "subtitle";
      text = triageClip(body.map((l) => l.content).join("\n"));
    }
  }
  if (source === "meta") {
    text = await triageBiliGet(`https://api.bilibili.com/x/v2/reply/main?type=1&oid=${v.aid}&mode=3&ps=10`)
      .then((d) => (d?.replies || []).slice(0, 10).map((r, i) => `${i + 1}. ${r.content?.message || ""}`).join("\n"))
      .catch(() => "");
    text = triageClip(text);
  }

  const tagList = Array.isArray(tags) ? tags : [];
  const criteria = await triageCriteriaText();
  const ai = await triageAiSettings();
  const { content, model } = await triageChat(triageBuildMessages(meta, source, text, criteria, tagList), triageMaxTokens("analyze", 1, ai), ai.triageThinking);
  const analysis = {
    bvid,
    status: "done",
    source,
    ...triageParseLlm(content, tagList),
    model,
    analyzedAt: Date.now()
  };
  await chrome.storage.local.set({ [cacheKey]: analysis });
  return analysis;
}

async function triageCriteriaText() {
  const { triageCriteria } = await chrome.storage.sync.get({ triageCriteria: "" });
  return String(triageCriteria || "");
}

// 非流式 chat/completions，只取 message.content（忽略 reasoning_content）
async function triageChat(messages, maxTokens, thinking = false) {
  const provider = (await loadAiProviders()).find((p) => p.enabled !== false);
  if (!provider) throw triageError("请先在设置页配置 AI 平台");
  const apiKey = (await loadAiProviderKeys())[provider.id];
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const baseUrl = String(provider.baseUrl || "").replace(/\/+$/, "");
  const body = { model: provider.model, stream: false, temperature: 0.3, max_tokens: maxTokens, messages };
  // DeepSeek 思考 token 计入 max_tokens；默认关（实测 30 标题 3s/815 token，开则约 19s/4579 token）。其他平台不发该参数
  if (/api\.deepseek\.com/.test(baseUrl)) body.thinking = { type: thinking ? "enabled" : "disabled" };
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw triageError(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = await res.json();
  const choice = json.choices?.[0];
  if (!choice?.message?.content && choice?.finish_reason === "length") {
    throw triageError("模型输出被截断（思考可能用光了额度），请调大输出上限或关闭思考");
  }
  return { content: choice?.message?.content, model: provider.model };
}

async function triageClassifyTitles({ items, tags }) {
  const list = (Array.isArray(items) ? items : []).filter((it) => it && it.bvid);
  if (!list.length) throw triageError("缺少 items");
  const tagList = Array.isArray(tags) ? tags : [];
  const system = `${triageWithCriteria(TRIAGE_TITLE_PROMPT, await triageCriteriaText())}\n\n${triageTagListText(tagList)}`;
  const user = list.map((it, idx) => triageTitleLine(it, idx + 1)).join("\n");
  const ai = await triageAiSettings();
  const { content, model } = await triageChat(
    [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    triageMaxTokens("title", list.length, ai),
    ai.triageThinking
  );
  const results = triageParseTitleBatch(content, list, tagList);
  const analyzedAt = Date.now();
  // "AI 未返回" 的不缓存，方便下次重试
  const toStore = {};
  for (const [bvid, r] of Object.entries(results)) {
    if (r.reason !== "AI 未返回") toStore[`triage_title_${bvid}`] = { ...r, model, analyzedAt };
  }
  await chrome.storage.local.set(toStore);
  return { results };
}

const TRIAGE_HANDLERS = {
  "triage-folders": () => triageCreatedFolders(),

  "triage-folder-items": async ({ mediaId }) => {
    if (!mediaId) throw triageError("缺少 mediaId");
    const items = [];
    for (let pn = 1; ; pn++) {
      if (pn > 1) await new Promise((r) => setTimeout(r, 300));
      const data = await triageBiliGet(`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${mediaId}&ps=20&pn=${pn}`);
      for (const m of data?.medias || []) {
        if (m.type !== 2) continue;
        items.push({
          bvid: m.bvid || m.bv_id,
          aid: m.id,
          title: m.title,
          cover: m.cover,
          upper: m.upper?.name || "",
          duration: m.duration,
          pubdate: m.pubtime,
          favTime: m.fav_time,
          intro: m.intro,
          invalid: m.attr !== 0
        });
      }
      if (!data?.has_more || !data?.medias?.length) break;
    }
    return { items };
  },

  "triage-analysis-get": async ({ bvids }) => {
    const list = Array.isArray(bvids) ? bvids : [];
    const stored = await chrome.storage.local.get(list.map((b) => `triage_analysis_${b}`));
    return Object.fromEntries(list.map((b) => [b, stored[`triage_analysis_${b}`] || null]));
  },

  "triage-analyze": (msg) => triageAnalyze(msg),

  "triage-classify-titles": (msg) => triageClassifyTitles(msg),

  "triage-title-get": async ({ bvids }) => {
    const list = Array.isArray(bvids) ? bvids : [];
    const stored = await chrome.storage.local.get(list.map((b) => `triage_title_${b}`));
    return Object.fromEntries(list.map((b) => [b, stored[`triage_title_${b}`] || null]));
  },

  "triage-unfav": async ({ mediaId, aids }) => {
    const list = Array.isArray(aids) ? aids : [];
    if (!mediaId || !list.length) throw triageError("缺少 mediaId 或 aids");
    await triageBiliPost("/x/v3/fav/resource/batch-del", {
      media_id: mediaId,
      resources: list.map((a) => `${a}:2`).join(","),
      platform: "web"
    });
    return { done: list.length };
  },

  "triage-refav": async ({ mediaId, aid }) => {
    if (!mediaId || !aid) throw triageError("缺少 mediaId 或 aid");
    await triageBiliPost("/x/v3/fav/resource/deal", { rid: aid, type: 2, add_media_ids: mediaId, del_media_ids: "" });
    return {};
  },

  "triage-settings-get": async () => {
    const s = await chrome.storage.sync.get(TRIAGE_SETTINGS_DEFAULTS);
    return {
      triageCriteria: String(s.triageCriteria || ""),
      triageIntervalSec: Number(s.triageIntervalSec) > 0 ? Number(s.triageIntervalSec) : 8,
      triageExportFolder: String(s.triageExportFolder || TRIAGE_SETTINGS_DEFAULTS.triageExportFolder),
      triageTitleBatchSize: Number(s.triageTitleBatchSize) > 0 ? Number(s.triageTitleBatchSize) : 30,
      triageThinking: s.triageThinking === true,
      triageTitleMaxTokens: Number(s.triageTitleMaxTokens) > 0 ? Number(s.triageTitleMaxTokens) : 0,
      triageAnalyzeMaxTokens: Number(s.triageAnalyzeMaxTokens) > 0 ? Number(s.triageAnalyzeMaxTokens) : 0
    };
  },

  "triage-settings-save": async (msg) => {
    const patch = {};
    for (const k of Object.keys(TRIAGE_SETTINGS_DEFAULTS)) if (msg[k] !== undefined) patch[k] = msg[k];
    await chrome.storage.sync.set(patch);
    return {};
  },

  // 与 background.js 的 write-obsidian-note 同一机制：Local REST API PUT /vault/<path>
  "triage-export": async ({ filename, markdown }) => {
    const name = String(filename || "").trim();
    if (!name) throw triageError("缺少文件名");
    const settings = await getMergedSettings();
    const { triageExportFolder } = await chrome.storage.sync.get(TRIAGE_SETTINGS_DEFAULTS);
    const baseUrl = String(settings.obsidianApiBaseUrl || "").trim();
    const apiKey = String(settings.obsidianApiKey || "").trim();
    if (!baseUrl || !apiKey) throw triageError("缺少 Local REST API 参数");
    const path = `${String(triageExportFolder || "").replace(/\/+$/g, "")}/${name}`;
    const encodedPath = path.split("/").filter(Boolean).map((s) => encodeURIComponent(s)).join("/");
    const res = await fetch(`${baseUrl.replace(/\/+$/g, "")}/vault/${encodedPath}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "text/markdown; charset=utf-8" },
      body: typeof markdown === "string" ? markdown : ""
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw triageError(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    return { path };
  }
};

const TRIAGE_DNR_RULE_ID = 91001;
function triageRegisterDnr() {
  chrome.declarativeNetRequest
    .updateSessionRules({
      removeRuleIds: [TRIAGE_DNR_RULE_ID],
      addRules: [
        {
          id: TRIAGE_DNR_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: "https://www.bilibili.com/" },
              { header: "Origin", operation: "set", value: "https://www.bilibili.com" }
            ]
          },
          condition: {
            requestDomains: ["api.bilibili.com"],
            tabIds: [chrome.tabs.TAB_ID_NONE],
            resourceTypes: ["xmlhttprequest", "other"]
          }
        }
      ]
    })
    .catch((e) => console.warn("[triage] DNR 规则注册失败", e));
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  triageRegisterDnr();
  chrome.runtime.onInstalled.addListener(triageRegisterDnr);
  chrome.runtime.onStartup.addListener(triageRegisterDnr);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = message?.type;
    if (typeof type !== "string" || !type.startsWith("triage-")) return false;
    const handler = TRIAGE_HANDLERS[type];
    if (!handler) {
      sendResponse({ ok: false, error: `未知消息类型 ${type}` });
      return false;
    }
    Promise.resolve()
      .then(() => handler(message))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e?.message || String(e), ...(e?.code ? { code: e.code } : {}) }));
    return true;
  });
}
