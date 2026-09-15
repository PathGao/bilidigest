"use strict";

// ---------- constants ----------
const THROTTLE_MS = globalThis.__TRIAGE_THROTTLE_MS || 10 * 60 * 1000;
const GROUP_SIZE = 8;
const SELECT_CAP = 10;
const SYNC_MIN_GAP_MS = 60 * 1000;
const UNDO_CAP = 20;
const TAG_COLORS = ["#7c62e8", "#2f8f5b", "#c9463d", "#a86a00", "#2a7ab8", "#b8428f", "#4f7a28", "#6b7180"];
const TABS = [
  ["unsure", "待定"],
  ["drop", "建议删"],
  ["keep", "建议留"],
  ["none", "未分析"],
  ["done", "已处理"],
  ["all", "全部"]
];
const K = {
  lastFolder: "triage_last_folder",
  tab: "triage_tab",
  tags: "triage_tags",
  videoTags: "triage_video_tags",
  basket: "triage_basket",
  decisions: (id) => `triage_decisions_${id}`,
  snapshot: (id) => `triage_snapshot_${id}`
};

// ---------- state ----------
const S = {
  folders: [],
  mediaId: "",
  folderToken: 0,
  items: [],
  itemMap: new Map(),
  titleRes: {},
  analyses: {},
  decisions: {},
  tags: [],
  videoTags: {},
  basket: [],
  settings: {
    triageCriteria: "",
    triageIntervalSec: 3,
    triageExportFolder: "",
    triageTitleBatchSize: 30,
    triageThinking: false,
    triageTitleMaxTokens: 0,
    triageAnalyzeMaxTokens: 0
  },
  tab: "all",
  tagFilter: new Set(),
  focused: "",
  focusIndex: 0,
  selected: new Set(),
  group: null, // { bvids: [], running: bool, stop: bool }
  stage1: { running: false, stop: false },
  stage1Skip: new Set(),
  analyzing: new Set(),
  throttleUntil: 0,
  status: "",
  undo: [],
  lastSyncAt: 0,
  syncing: false
};

const $ = (id) => document.getElementById(id);
const el = {};
[
  "folderSelect", "refreshBtn", "progress", "queueStatus", "stage1Btn", "groupBtn", "settingsBtn", "helpBtn",
  "banner", "bannerText", "bannerBtn", "syncNotice", "syncText", "syncViewBtn", "syncCloseBtn", "syncDetail",
  "tabs", "tagFilter", "manageTagsBtn", "listHeader", "list", "basket", "basketToggle", "basketCount",
  "basketList", "copyMdBtn", "exportBtn", "toast", "settingsDialog", "criteriaInput", "intervalInput",
  "batchSizeInput", "exportFolderInput", "openOptionsBtn", "aiDebugTitle", "thinkingInput", "titleMaxInput",
  "titleMaxHint", "analyzeMaxInput", "analyzeMaxHint", "settingsError", "backupBtn", "csvBtn", "confirmDialog",
  "confirmTitle", "confirmBody", "confirmOk", "pickerDialog", "pickerTitle", "pickerInput", "pickerList",
  "tagsDialog", "tagsRows", "newTagInput", "addTagBtn", "helpDialog"
].forEach((id) => (el[id] = $(id)));

// ---------- utils ----------
function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve(resp || { ok: false, error: "后台无响应" });
      });
    } catch (e) {
      resolve({ ok: false, error: e?.message || String(e) });
    }
  });
}

async function storeGet(key, fallback) {
  const r = await chrome.storage.local.get(key);
  return r?.[key] ?? fallback;
}
function storeSet(key, value) {
  return chrome.storage.local.set({ [key]: value });
}

function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const pad = (n) => String(n).padStart(2, "0");
function fmtDuration(sec) {
  sec = Math.max(0, Number(sec) || 0);
  return `${pad(Math.floor(sec / 60))}:${pad(Math.floor(sec % 60))}`;
}
function stamp(d = new Date(), withTime = true) {
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${day}-${pad(d.getHours())}${pad(d.getMinutes())}` : day;
}
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${stamp(d, false)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const videoUrl = (bvid) => `https://www.bilibili.com/video/${bvid}`;
const stripNew = (name) => String(name).replace(/^新[:：]\s*/, "").trim();

// Waits ms, returning early when keepGoing() turns false.
async function sleepWhile(ms, keepGoing) {
  const end = Date.now() + ms;
  while (Date.now() < end && keepGoing()) {
    await new Promise((r) => setTimeout(r, Math.min(200, end - Date.now())));
  }
}

function openTab(url) {
  chrome.tabs.create({ url });
}

let toastTimer = 0;
function toast(text, error = false) {
  el.toast.textContent = text;
  el.toast.classList.toggle("error", error);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 6000);
}

function askConfirm(title, bodyHtml, okText) {
  el.confirmTitle.textContent = title;
  el.confirmBody.innerHTML = bodyHtml;
  el.confirmOk.textContent = okText;
  el.confirmOk.setAttribute("aria-label", okText);
  el.confirmDialog.returnValue = "";
  el.confirmDialog.showModal();
  return new Promise((resolve) => {
    el.confirmDialog.addEventListener("close", () => resolve(el.confirmDialog.returnValue === "ok"), { once: true });
  });
}

function showBanner(text, btnText, onClick) {
  el.bannerText.textContent = text;
  el.bannerBtn.textContent = btnText;
  el.bannerBtn.setAttribute("aria-label", btnText);
  el.bannerBtn.onclick = onClick;
  el.banner.hidden = false;
}

function handleAiError(error) {
  const text = String(error || "AI 调用失败");
  if (text.includes("配置 AI")) {
    showBanner(`还没有可用的 AI 服务：${text}`, "去配置", () => send({ type: "open-options" }));
  } else if (text.includes("截断")) {
    showBanner(`${text}。建议调大输出上限或关闭思考`, "打开 AI 调试", () => openSettings(true));
  }
  toast(text, true);
}

// ---------- derived ----------
const tagById = (id) => S.tags.find((t) => t.id === id);
const tagIdsOf = (bvid) => (S.videoTags[bvid] || []).filter((id) => tagById(id));
const isProcessed = (bvid) => Boolean(S.decisions[bvid]) || tagIdsOf(bvid).length > 0;

function verdictOf(it) {
  const a = S.analyses[it.bvid];
  const failed = a?.status === "error" ? a.error || "分析失败" : "";
  if (it.invalid) return { verdict: "drop", reason: "视频已失效", stage: 0, failed: "" };
  if (a?.status === "done") return { verdict: a.verdict, reason: a.reason, stage: 2, failed: "" };
  const t = S.titleRes[it.bvid];
  if (t) return { verdict: t.verdict, reason: t.reason, stage: 1, low: t.confidence === "low", failed };
  return { verdict: "none", reason: "", stage: -1, failed };
}

function suggestionsOf(bvid) {
  const a = S.analyses[bvid];
  const list = (a?.status === "done" && a.suggestedTags) || S.titleRes[bvid]?.suggestedTags || [];
  const have = new Set(tagIdsOf(bvid).map((id) => tagById(id).name));
  return [...new Set(list)].filter((n) => stripNew(n) && !have.has(stripNew(n)));
}

function passTagFilter(bvid) {
  return S.tagFilter.size === 0 || tagIdsOf(bvid).some((id) => S.tagFilter.has(id));
}

function inTab(it, tab) {
  if (tab === "all") return true;
  const p = isProcessed(it.bvid);
  if (tab === "done") return p;
  return !p && verdictOf(it).verdict === tab;
}

function visibleItems() {
  if (S.tab === "group" && S.group) {
    return S.group.bvids.map((b) => S.itemMap.get(b)).filter(Boolean);
  }
  return S.items.filter((it) => inTab(it, S.tab) && passTagFilter(it.bvid));
}

function proposeGroup(exclude = new Set()) {
  if (S.selected.size) return [...S.selected].filter((b) => S.itemMap.has(b)).slice(0, SELECT_CAP);
  const open = (it) => !it.invalid && !isProcessed(it.bvid) && S.analyses[it.bvid]?.status !== "done" && !exclude.has(it.bvid);
  const unsure = S.items.filter((it) => open(it) && verdictOf(it).verdict === "unsure");
  const low = S.items.filter((it) => open(it) && verdictOf(it).low && verdictOf(it).verdict !== "unsure");
  return [...unsure, ...low].slice(0, GROUP_SIZE).map((it) => it.bvid);
}

// ---------- init ----------
init();

async function init() {
  bindEvents();
  const [tags, videoTags, basket, settingsResp] = await Promise.all([
    storeGet(K.tags, []),
    storeGet(K.videoTags, {}),
    storeGet(K.basket, []),
    send({ type: "triage-settings-get" })
  ]);
  S.tags = tags;
  S.videoTags = videoTags;
  S.basket = basket;
  if (settingsResp.ok) Object.assign(S.settings, settingsResp.data);
  renderBasket();
  await loadFolders();
  setInterval(tick, 1000);
}

async function loadFolders() {
  el.banner.hidden = true;
  const r = await send({ type: "triage-folders" });
  if (!r.ok) {
    const needLogin = r.code === "NOT_LOGGED_IN" || /登录/.test(r.error || "");
    if (needLogin) showBanner(`未登录 B 站：${r.error}`, "去登录", () => openTab("https://passport.bilibili.com/login"));
    else showBanner(`读取收藏夹失败：${r.error}`, "重试", loadFolders);
    el.list.innerHTML = `<p class="empty">无法读取收藏夹</p>`;
    return;
  }
  S.folders = r.data.folders || [];
  el.folderSelect.innerHTML = S.folders
    .map((f) => `<option value="${esc(f.id)}">${esc(f.title)} (${esc(f.count)})</option>`)
    .join("");
  if (!S.folders.length) {
    el.list.innerHTML = `<p class="empty">没有找到收藏夹</p>`;
    return;
  }
  const last = String(await storeGet(K.lastFolder, ""));
  const pick = S.folders.find((f) => String(f.id) === last) || S.folders[0];
  el.folderSelect.value = String(pick.id);
  await openFolder(String(pick.id));
}

async function openFolder(mediaId) {
  S.folderToken++;
  S.stage1.stop = true;
  if (S.group) S.group.stop = true;
  S.mediaId = mediaId;
  S.items = [];
  S.itemMap = new Map();
  S.group = null;
  S.selected.clear();
  S.undo = [];
  S.stage1Skip.clear();
  S.focused = "";
  S.focusIndex = 0;
  S.throttleUntil = 0;
  S.status = "";
  el.syncNotice.hidden = true;
  storeSet(K.lastFolder, mediaId);
  el.list.innerHTML = `<p class="empty">加载中…</p>`;
  S.decisions = await storeGet(K.decisions(mediaId), {});
  const ok = await syncFolder({ force: true });
  if (!ok) return;
  const hasAi = S.items.some((it) => S.titleRes[it.bvid] || S.analyses[it.bvid]?.status === "done");
  S.tab = hasAi ? await storeGet(K.tab, "unsure") : "all";
  if (S.tab === "group") S.tab = "unsure";
  S.focused = visibleItems()[0]?.bvid || "";
  render();
}

// ---------- sync with bilibili ----------
async function syncFolder({ force = false } = {}) {
  if (S.syncing || (!force && Date.now() - S.lastSyncAt < SYNC_MIN_GAP_MS)) return false;
  S.syncing = true;
  const token = S.folderToken;
  const mediaId = S.mediaId;
  try {
    const r = await send({ type: "triage-folder-items", mediaId });
    if (token !== S.folderToken) return false;
    if (!r.ok) {
      const needLogin = r.code === "NOT_LOGGED_IN" || /登录/.test(r.error || "");
      if (needLogin) showBanner(`未登录 B 站：${r.error}`, "去登录", () => openTab("https://passport.bilibili.com/login"));
      else toast(`刷新收藏夹失败：${r.error}`, true);
      if (!S.items.length) el.list.innerHTML = `<p class="empty">无法读取这个收藏夹</p>`;
      return false;
    }
    S.lastSyncAt = Date.now();
    const remote = r.data.items || [];
    const remoteSet = new Set(remote.map((it) => it.bvid));
    const snap = await storeGet(K.snapshot(mediaId), null);
    const diff = { added: [], removed: [], invalid: [], restored: [] };
    const restored = new Set();

    for (const it of remote) {
      if (S.decisions[it.bvid]?.action === "unfav") {
        delete S.decisions[it.bvid];
        restored.add(it.bvid);
        diff.restored.push(it.title);
      }
    }
    if (snap) {
      const snapSet = new Set(snap.bvids);
      const snapInvalid = new Set(snap.invalid || []);
      for (const it of remote) {
        if (!snapSet.has(it.bvid) && !restored.has(it.bvid)) diff.added.push(it);
        if (it.invalid && snapSet.has(it.bvid) && !snapInvalid.has(it.bvid)) diff.invalid.push(it.title);
      }
      for (const b of snap.bvids) {
        if (!remoteSet.has(b) && S.decisions[b]?.action !== "unfav") diff.removed.push(snap.titles?.[b] || b);
      }
    }
    if (restored.size) storeSet(K.decisions(mediaId), S.decisions);

    // Remote order, newly added first; keep items we unfavorited this session so undo stays possible.
    const addedSet = new Set(diff.added.map((it) => it.bvid));
    const next = [...remote.filter((it) => addedSet.has(it.bvid)), ...remote.filter((it) => !addedSet.has(it.bvid))];
    for (const it of S.items) {
      if (!remoteSet.has(it.bvid) && S.decisions[it.bvid]?.action === "unfav") next.push(it);
    }
    S.items = next;
    S.itemMap = new Map(next.map((it) => [it.bvid, it]));
    if (S.group) S.group.bvids = S.group.bvids.filter((b) => S.itemMap.has(b));
    for (const b of [...S.selected]) if (!S.itemMap.has(b)) S.selected.delete(b);

    storeSet(K.snapshot(mediaId), {
      bvids: remote.map((it) => it.bvid),
      invalid: remote.filter((it) => it.invalid).map((it) => it.bvid),
      titles: Object.fromEntries(remote.map((it) => [it.bvid, it.title])),
      at: Date.now()
    });

    const missing = next.map((it) => it.bvid).filter((b) => !(b in S.titleRes) && !(b in S.analyses));
    if (missing.length) {
      const [t, a] = await Promise.all([
        send({ type: "triage-title-get", bvids: missing }),
        send({ type: "triage-analysis-get", bvids: missing })
      ]);
      if (token !== S.folderToken) return false;
      for (const b of missing) {
        if (t.ok && t.data?.[b]) S.titleRes[b] = t.data[b];
        if (a.ok && a.data?.[b]) S.analyses[b] = a.data[b];
      }
    }
    showSyncNotice(diff);
    render();
    return true;
  } finally {
    S.syncing = false;
  }
}

function showSyncNotice(diff) {
  const { added, removed, invalid, restored } = diff;
  if (!added.length && !removed.length && !invalid.length && !restored.length) return;
  const parts = [`新增 ${added.length}`, `已在B站移除 ${removed.length}`, `已失效 ${invalid.length}`];
  if (restored.length) parts.push(`恢复 ${restored.length}`);
  el.syncText.textContent = `B站同步：${parts.join(" · ")}`;
  const section = (label, titles) =>
    titles.length ? `<div><strong>${label}</strong><ul>${titles.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : "";
  el.syncDetail.innerHTML =
    section("新增", added.map((it) => it.title)) +
    section("已在B站移除", removed) +
    section("已失效", invalid) +
    section("恢复（在B站重新收藏）", restored);
  el.syncDetail.hidden = true;
  el.syncNotice.hidden = false;
}

// ---------- render ----------
function render() {
  renderTop();
  renderTabs();
  renderList();
}

function renderTop() {
  const total = S.items.length;
  const classified = S.items.filter((it) => it.invalid || S.titleRes[it.bvid]).length;
  const deep = S.items.filter((it) => S.analyses[it.bvid]?.status === "done").length;
  const processed = S.items.filter((it) => isProcessed(it.bvid)).length;
  el.progress.textContent = `已粗分 ${classified} / ${total} · 已细看 ${deep} · 已处理 ${processed}`;

  const groupRunning = Boolean(S.group?.running);
  el.stage1Btn.textContent = S.stage1.running ? "暂停粗分" : "标题粗分";
  el.stage1Btn.setAttribute("aria-label", el.stage1Btn.textContent);
  el.stage1Btn.disabled = groupRunning || (!S.stage1.running && !S.items.length);

  let label;
  if (groupRunning) label = "暂停细看";
  else if (S.group && S.group.bvids.some((b) => needsAnalysis(b))) label = `继续细看 (${S.group.bvids.length})`;
  else {
    const n = proposeGroup(new Set(S.group?.bvids || [])).length;
    label = S.selected.size ? `细看选中 (${n})` : `细看这一组 (${n})`;
  }
  el.groupBtn.textContent = label;
  el.groupBtn.setAttribute("aria-label", label);
  el.groupBtn.disabled = S.stage1.running || (!groupRunning && label.endsWith("(0)"));
  renderStatus();
}

function renderStatus() {
  const left = S.throttleUntil - Date.now();
  if (left > 0) {
    el.queueStatus.textContent = `AI 限流，${fmtDuration(Math.ceil(left / 1000))} 后重试`;
    el.queueStatus.classList.add("warn");
  } else {
    el.queueStatus.textContent = S.status;
    el.queueStatus.classList.remove("warn");
  }
}

function tick() {
  if (S.throttleUntil) renderStatus();
}

function renderTabs() {
  const counts = {};
  for (const [key] of TABS) counts[key] = 0;
  for (const it of S.items) {
    if (!passTagFilter(it.bvid)) continue;
    counts.all++;
    if (isProcessed(it.bvid)) counts.done++;
    else counts[verdictOf(it).verdict]++;
  }
  const tabs = [...TABS];
  if (S.group) {
    const done = S.group.bvids.filter(isProcessed).length;
    tabs.unshift(["group", "本轮细看", `${done}/${S.group.bvids.length}`]);
  }
  el.tabs.innerHTML = tabs
    .map(([key, label, extra]) => {
      const n = extra ?? counts[key];
      return `<button type="button" role="tab" data-tab="${key}" aria-selected="${S.tab === key}" aria-label="${label} ${n}">${label}<span class="count">${n}</span></button>`;
    })
    .join("");

  el.tagFilter.innerHTML = S.tags.length
    ? S.tags
        .map(
          (t) =>
            `<button type="button" class="chip${S.tagFilter.has(t.id) ? " on" : ""}" style="--c:${esc(t.color)}" data-tagfilter="${esc(t.id)}" aria-pressed="${S.tagFilter.has(t.id)}" aria-label="按标签筛选 ${esc(t.name)}">${esc(t.name)}</button>`
        )
        .join("")
    : `<span class="muted">还没有标签，按 T 给视频打标签</span>`;
}

function renderListHeader(list) {
  let html = "";
  if (S.tab === "group" && S.group) {
    const done = S.group.bvids.filter(isProcessed).length;
    html = `<span class="group-title">本轮细看 · 已处理 ${done} / ${S.group.bvids.length}</span><span class="spacer"></span>
      <button type="button" data-head="next-group" aria-label="下一组">下一组</button>
      <button type="button" data-head="end-group" aria-label="结束本轮">结束本轮</button>`;
  } else if (S.tab === "drop" && list.length) {
    html = `<button type="button" class="danger" data-head="batch-unfav" aria-label="确认删除这 ${list.length} 个">确认删除这 ${list.length} 个</button>`;
  } else if (S.tab === "keep" && list.length) {
    html = `<button type="button" data-head="batch-keep" aria-label="全部标记保留">全部标记保留 (${list.length})</button>`;
  }
  if (S.selected.size) {
    html += `<span class="muted">已选中 ${S.selected.size} 个</span><button type="button" class="link" data-head="clear-selected" aria-label="清空选中">清空选中</button>`;
  }
  el.listHeader.innerHTML = html;
  el.listHeader.hidden = !html;
}

function renderList() {
  const list = visibleItems();
  renderListHeader(list);
  if (!S.items.length) {
    el.list.innerHTML = `<p class="empty">这个收藏夹是空的</p>`;
    return;
  }
  if (!list.length) {
    el.list.innerHTML = `<p class="empty">这里没有视频</p>`;
    return;
  }
  if (!list.some((it) => it.bvid === S.focused)) {
    S.focused = list[Math.min(S.focusIndex, list.length - 1)].bvid;
  }
  S.focusIndex = list.findIndex((it) => it.bvid === S.focused);
  const expanded = S.tab === "group";
  const scroll = el.list.scrollTop;
  el.list.innerHTML = list.map((it) => cardHtml(it, expanded)).join("");
  el.list.scrollTop = scroll;
}

const VERDICT_LABEL = { drop: "建议删", keep: "建议留", unsure: "待定", none: "未分析" };
const ACTION_LABEL = { unfav: "已取消收藏", keep: "已保留" };

function cardHtml(it, expanded) {
  const b = it.bvid;
  const v = verdictOf(it);
  const a = S.analyses[b];
  const done = a?.status === "done";
  const decision = S.decisions[b];
  const inBasket = S.basket.some((x) => x.bvid === b);
  const cls = ["card"];
  if (b === S.focused) cls.push("focused");
  if (isProcessed(b)) cls.push("decided");
  if (S.selected.has(b)) cls.push("selected");

  const meta = [it.upper, fmtDuration(it.duration)];
  if (done) meta.push(`来源：${a.source === "subtitle" ? "字幕" : "简介"}`);
  if (it.invalid) meta.push("已失效");

  let verdict;
  if (S.analyzing.has(b)) verdict = `<span class="badge running">分析中…</span>`;
  else verdict = `<span class="badge ${v.verdict}${v.low ? " low" : ""}">${VERDICT_LABEL[v.verdict]}${v.low ? " · 低置信" : ""}</span>`;
  const stageMark = v.stage === 1 ? `<span class="stage">标题判断</span>` : v.stage === 2 ? `<span class="stage">字幕判断</span>` : "";
  const failed = v.failed
    ? `<span class="fail-text">分析失败：${esc(v.failed)}</span><button type="button" data-act="retry" aria-label="重试分析">重试</button>`
    : "";

  const chips = tagIdsOf(b)
    .map((id) => {
      const t = tagById(id);
      return `<span class="chip on" style="--c:${esc(t.color)}">${esc(t.name)}</span>`;
    })
    .join("");
  const sugg = suggestionsOf(b);
  const suggHtml = sugg.length
    ? `<button type="button" class="chip suggest" data-act="accept" aria-label="采纳建议标签 ${esc(sugg.join("、"))}">建议 ${sugg
        .map((n) => esc(n))
        .join(" · ")}</button>`
    : "";

  const body = [];
  if (done && a.oneLiner) body.push(`<p class="oneliner">${esc(a.oneLiner)}</p>`);
  if (done && expanded && a.points?.length) body.push(`<ol class="points">${a.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>`);

  return `<article class="${cls.join(" ")}" data-bvid="${esc(b)}" aria-label="${esc(it.title)}">
    <img class="cover" src="${esc(it.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
    <div class="card-body">
      <button type="button" class="title" data-act="open" aria-label="打开视频 ${esc(it.title)}">${esc(it.title)}</button>
      <div class="meta">${meta.map(esc).join(" · ")}</div>
      ${body.join("")}
      <div class="card-foot">${verdict}${stageMark}<span class="reason">${esc(v.reason)}</span>${failed}</div>
      ${chips || suggHtml ? `<div class="chips">${chips}${suggHtml}</div>` : ""}
      <div class="card-foot">
        ${decision ? `<span class="badge decision">${ACTION_LABEL[decision.action]}</span>` : ""}
        <span class="spacer"></span>
        <div class="actions">
          <button type="button" data-act="unfav" aria-label="取消收藏 (D)"${decision?.action === "unfav" ? " disabled" : ""}>取消收藏 D</button>
          <button type="button" data-act="keep" aria-label="保留 (S)"${decision ? " disabled" : ""}>保留 S</button>
          <button type="button" data-act="tag" aria-label="打标签 (T)">标签 T</button>
          <button type="button" data-act="basket" class="${inBasket ? "on" : ""}" aria-pressed="${inBasket}" aria-label="摘录篮 (E)">摘录 E</button>
          <button type="button" data-act="select" class="${S.selected.has(b) ? "on" : ""}" aria-pressed="${S.selected.has(b)}" aria-label="选中 (X)">选中 X</button>
        </div>
      </div>
    </div>
  </article>`;
}

function setFocus(bvid, scroll = true) {
  S.focused = bvid;
  const list = visibleItems();
  S.focusIndex = Math.max(0, list.findIndex((it) => it.bvid === bvid));
  for (const node of el.list.querySelectorAll(".card.focused")) node.classList.remove("focused");
  const card = el.list.querySelector(`.card[data-bvid="${CSS.escape(bvid)}"]`);
  if (card) {
    card.classList.add("focused");
    if (scroll) card.scrollIntoView({ block: "nearest" });
  }
}

function moveFocus(delta) {
  const list = visibleItems();
  if (!list.length) return;
  const i = list.findIndex((it) => it.bvid === S.focused);
  const next = Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i + delta)));
  setFocus(list[next].bvid);
}

// Focus the next unprocessed card after `bvid` in the given pre-change list.
function advanceFrom(bvid, before) {
  const i = before.findIndex((it) => it.bvid === bvid);
  const now = new Set(visibleItems().map((it) => it.bvid));
  const next =
    before.slice(i + 1).find((it) => now.has(it.bvid) && !isProcessed(it.bvid)) ||
    visibleItems().find((it) => !isProcessed(it.bvid));
  if (next) setFocus(next.bvid);
  else setFocus(S.focused, true);
}

// ---------- decisions ----------
function pushUndo(entry) {
  S.undo.push(entry);
  if (S.undo.length > UNDO_CAP) S.undo.shift();
}
const saveDecisions = () => storeSet(K.decisions(S.mediaId), S.decisions);
const saveVideoTags = () => storeSet(K.videoTags, S.videoTags);
const shortTitle = (it) => (it.title.length > 24 ? `${it.title.slice(0, 24)}…` : it.title);

async function decide(bvid, action) {
  const it = S.itemMap.get(bvid);
  if (!it) return;
  const prev = S.decisions[bvid] || null;
  if (prev?.action === action) return;
  if (prev?.action === "unfav") {
    toast("这个视频已取消收藏，按 U 撤销后再改", true);
    return;
  }
  const before = visibleItems();
  if (action === "unfav") {
    const r = await send({ type: "triage-unfav", mediaId: S.mediaId, aids: [it.aid] });
    if (!r.ok) {
      toast(`取消收藏失败：${r.error}`, true);
      return;
    }
  }
  S.decisions[bvid] = { action, at: Date.now() };
  saveDecisions();
  pushUndo({ kind: "decision", bvid, action, prev });
  toast(`${action === "unfav" ? "已取消收藏" : "已保留"}《${shortTitle(it)}》 · 撤销(U)`);
  render();
  advanceFrom(bvid, before);
  afterProcessedChange();
}

async function undo() {
  const entry = S.undo.pop();
  if (!entry) {
    toast("没有可撤销的操作");
    return;
  }
  if (entry.kind === "decision") {
    const it = S.itemMap.get(entry.bvid);
    if (entry.action === "unfav") {
      const r = await send({ type: "triage-refav", mediaId: S.mediaId, aid: it.aid });
      if (!r.ok) {
        S.undo.push(entry);
        toast(`撤销失败：${r.error}`, true);
        return;
      }
    }
    if (entry.prev) S.decisions[entry.bvid] = entry.prev;
    else delete S.decisions[entry.bvid];
    saveDecisions();
    toast(`已撤销：${entry.action === "unfav" ? "重新收藏" : "取消保留"}《${shortTitle(it)}》`);
    S.focused = entry.bvid;
  } else if (entry.kind === "keepMany") {
    for (const b of entry.bvids) delete S.decisions[b];
    saveDecisions();
    toast(`已撤销批量保留 ${entry.bvids.length} 个`);
  } else if (entry.kind === "tags") {
    if (entry.prev.length) S.videoTags[entry.bvid] = entry.prev;
    else delete S.videoTags[entry.bvid];
    saveVideoTags();
    toast("已撤销标签修改");
    S.focused = entry.bvid;
  }
  render();
  setFocus(S.focused);
}

async function batchUnfav(btn) {
  const list = visibleItems().filter((it) => !isProcessed(it.bvid));
  if (!list.length) return;
  const titles = list.slice(0, 10).map((it) => `<li>${esc(it.title)}</li>`).join("");
  const more = list.length > 10 ? `<p>等 ${list.length} 个</p>` : "";
  const ok = await askConfirm(`取消收藏这 ${list.length} 个视频？`, `<ul>${titles}</ul>${more}`, `确认删除 ${list.length} 个`);
  if (!ok) return;
  const token = S.folderToken;
  let done = 0;
  btn.disabled = true;
  for (let i = 0; i < list.length; i += 20) {
    const chunk = list.slice(i, i + 20);
    btn.textContent = `删除中 ${done}/${list.length}`;
    const r = await send({ type: "triage-unfav", mediaId: S.mediaId, aids: chunk.map((it) => it.aid) });
    if (token !== S.folderToken) return;
    if (!r.ok) {
      toast(`批量取消收藏失败（已完成 ${done} 个）：${r.error}`, true);
      break;
    }
    const at = Date.now();
    for (const it of chunk) S.decisions[it.bvid] = { action: "unfav", at };
    saveDecisions();
    done += chunk.length;
    if (i + 20 < list.length) await new Promise((r2) => setTimeout(r2, 1000));
  }
  if (done) toast(`已取消收藏 ${done} 个`);
  render();
  afterProcessedChange();
}

function batchKeep() {
  const list = visibleItems().filter((it) => !isProcessed(it.bvid));
  if (!list.length) return;
  const at = Date.now();
  for (const it of list) S.decisions[it.bvid] = { action: "keep", at };
  saveDecisions();
  pushUndo({ kind: "keepMany", bvids: list.map((it) => it.bvid) });
  toast(`已标记保留 ${list.length} 个 · 撤销(U)`);
  render();
}

// ---------- tags ----------
const saveTags = () => storeSet(K.tags, S.tags);

function createTag(name) {
  name = stripNew(name);
  const existing = S.tags.find((t) => t.name === name);
  if (existing) return existing;
  const tag = { id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, color: TAG_COLORS[S.tags.length % TAG_COLORS.length] };
  S.tags.push(tag);
  saveTags();
  return tag;
}

function setVideoTags(bvid, ids, prev) {
  const same = ids.length === prev.length && ids.every((id) => prev.includes(id));
  if (same) return false;
  if (ids.length) S.videoTags[bvid] = ids;
  else delete S.videoTags[bvid];
  saveVideoTags();
  pushUndo({ kind: "tags", bvid, prev });
  return true;
}

function acceptSuggestions(bvid) {
  const sugg = suggestionsOf(bvid);
  if (!sugg.length) {
    toast("这个视频没有待采纳的建议标签");
    return;
  }
  const prev = tagIdsOf(bvid);
  const ids = [...prev];
  for (const name of sugg) {
    const t = createTag(name);
    if (!ids.includes(t.id)) ids.push(t.id);
  }
  setVideoTags(bvid, ids, prev);
  toast(`已添加标签：${sugg.map(stripNew).join("、")} · 撤销(U)`);
  render();
  afterProcessedChange();
}

const picker = { bvid: "", prev: [], ids: [], index: 0, options: [] };

function openPicker(bvid) {
  const it = S.itemMap.get(bvid);
  if (!it) return;
  picker.bvid = bvid;
  picker.prev = tagIdsOf(bvid);
  picker.ids = [...picker.prev];
  picker.index = 0;
  el.pickerTitle.textContent = `打标签 ·《${shortTitle(it)}》`;
  el.pickerInput.value = "";
  renderPicker();
  el.pickerDialog.showModal();
  el.pickerInput.focus();
}

function renderPicker() {
  const q = el.pickerInput.value.trim();
  const opts = S.tags.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase())).map((t) => ({ tag: t }));
  if (q && !S.tags.some((t) => t.name === stripNew(q))) opts.unshift({ create: stripNew(q) });
  picker.options = opts;
  picker.index = Math.min(picker.index, Math.max(0, opts.length - 1));
  el.pickerList.innerHTML = opts.length
    ? opts
        .map((o, i) => {
          const active = i === picker.index ? " active" : "";
          if (o.create) return `<li role="option" class="picker-opt${active}" data-i="${i}" aria-selected="${i === picker.index}">新建「${esc(o.create)}」</li>`;
          const on = picker.ids.includes(o.tag.id);
          return `<li role="option" class="picker-opt${active}" data-i="${i}" aria-selected="${i === picker.index}" aria-checked="${on}"><span class="check">${on ? "✓" : ""}</span><span class="dot" style="--c:${esc(o.tag.color)}"></span>${esc(o.tag.name)}</li>`;
        })
        .join("")
    : `<li class="muted">输入名称后回车新建标签</li>`;
  el.pickerList.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

function pickOption(i) {
  const o = picker.options[i];
  if (!o) return;
  if (o.create) {
    const t = createTag(o.create);
    picker.ids.push(t.id);
    el.pickerInput.value = "";
    picker.index = 0;
  } else if (picker.ids.includes(o.tag.id)) {
    picker.ids = picker.ids.filter((id) => id !== o.tag.id);
  } else {
    picker.ids.push(o.tag.id);
  }
  renderPicker();
}

function closePicker() {
  const changed = setVideoTags(picker.bvid, picker.ids, picker.prev);
  render();
  if (changed) {
    toast("标签已更新 · 撤销(U)");
    afterProcessedChange();
  }
  setFocus(S.focused, true);
}

function renderTagManager() {
  const counts = {};
  for (const ids of Object.values(S.videoTags)) for (const id of ids) counts[id] = (counts[id] || 0) + 1;
  el.tagsRows.innerHTML = S.tags.length
    ? S.tags
        .map(
          (t) => `<div class="tag-row" data-id="${esc(t.id)}">
      <input type="color" value="${esc(t.color)}" data-field="color" aria-label="标签颜色 ${esc(t.name)}" />
      <input type="text" value="${esc(t.name)}" data-field="name" aria-label="标签名称" />
      <span class="muted">${counts[t.id] || 0} 个视频</span>
      <button type="button" class="danger" data-field="delete" aria-label="删除标签 ${esc(t.name)}">删除</button>
    </div>`
        )
        .join("")
    : `<p class="muted">还没有标签</p>`;
}

async function deleteTag(id) {
  const t = tagById(id);
  const n = Object.values(S.videoTags).filter((ids) => ids.includes(id)).length;
  const ok = await askConfirm(`删除标签「${t.name}」？`, `<p>将从 ${n} 个视频上移除这个标签，无法撤销。</p>`, "删除");
  if (!ok) return;
  S.tags = S.tags.filter((x) => x.id !== id);
  for (const [b, ids] of Object.entries(S.videoTags)) {
    const rest = ids.filter((x) => x !== id);
    if (rest.length) S.videoTags[b] = rest;
    else delete S.videoTags[b];
  }
  S.tagFilter.delete(id);
  S.undo = S.undo.filter((e) => e.kind !== "tags");
  saveTags();
  saveVideoTags();
  renderTagManager();
  render();
}

// ---------- AI stage 1: titles ----------
function aiItem(it) {
  return { bvid: it.bvid, title: it.title, upper: it.upper, duration: it.duration, intro: it.intro };
}

async function throttleWait(keepGoing) {
  S.throttleUntil = Date.now() + THROTTLE_MS;
  renderStatus();
  await sleepWhile(THROTTLE_MS, keepGoing);
  S.throttleUntil = 0;
  renderStatus();
}

async function runStage1() {
  const token = S.folderToken;
  S.stage1 = { running: true, stop: false };
  const keepGoing = () => !S.stage1.stop && token === S.folderToken;
  const size = Math.max(1, Number(S.settings.triageTitleBatchSize) || 30);
  const pending = () => S.items.filter((it) => !it.invalid && !S.titleRes[it.bvid] && !isProcessed(it.bvid) && !S.stage1Skip.has(it.bvid));
  const total = pending().length;
  let done = 0;
  render();
  while (keepGoing()) {
    const batch = pending().slice(0, size);
    if (!batch.length) break;
    S.status = `标题粗分中 ${done}/${total}`;
    renderStatus();
    const r = await send({ type: "triage-classify-titles", items: batch.map(aiItem), tags: S.tags.map((t) => t.name) });
    if (token !== S.folderToken) break;
    if (!r.ok) {
      if (r.code === "THROTTLED") {
        await throttleWait(keepGoing);
        continue;
      }
      handleAiError(r.error);
      break;
    }
    const results = r.data?.results || {};
    for (const it of batch) {
      if (results[it.bvid]) S.titleRes[it.bvid] = results[it.bvid];
      else S.stage1Skip.add(it.bvid);
    }
    done += batch.length;
    render();
    if (pending().length) await sleepWhile(S.settings.triageIntervalSec * 1000, keepGoing);
  }
  if (token !== S.folderToken) return;
  S.stage1.running = false;
  S.status = done ? `标题粗分完成 ${done} 个` : "";
  render();
}

// ---------- AI stage 2: subtitle group ----------
const needsAnalysis = (b) => {
  const it = S.itemMap.get(b);
  const a = S.analyses[b];
  return it && !it.invalid && !isProcessed(b) && a?.status !== "done" && a?.status !== "error";
};

function startGroup(bvids) {
  if (!bvids.length) {
    toast("没有需要细看的视频了");
    return;
  }
  S.group = { bvids, running: false, stop: false };
  S.selected.clear();
  S.tab = "group";
  S.focused = bvids[0];
  S.focusIndex = 0;
  render();
  setFocus(S.focused);
  runGroup();
}

async function analyzeOne(bvid, force = false) {
  S.analyzing.add(bvid);
  render();
  const r = await send({ type: "triage-analyze", bvid, force, tags: S.tags.map((t) => t.name) });
  S.analyzing.delete(bvid);
  return r;
}

async function runGroup() {
  const group = S.group;
  if (!group || group.running) return;
  const token = S.folderToken;
  group.running = true;
  group.stop = false;
  const keepGoing = () => !group.stop && S.group === group && token === S.folderToken;
  render();
  while (keepGoing()) {
    const b = group.bvids.find(needsAnalysis);
    if (!b) break;
    const idx = group.bvids.filter((x) => !needsAnalysis(x)).length + 1;
    S.status = `字幕细看 ${idx}/${group.bvids.length}`;
    const r = await analyzeOne(b);
    if (token !== S.folderToken) return;
    if (!r.ok && r.code === "THROTTLED") {
      render();
      await throttleWait(keepGoing);
      continue;
    }
    S.analyses[b] = r.ok ? r.data : { bvid: b, status: "error", error: r.error };
    const err = S.analyses[b].status === "error" ? String(S.analyses[b].error || "") : "";
    if (/配置 AI|截断/.test(err)) handleAiError(err);
    if (err.includes("配置 AI")) group.stop = true;
    render();
    if (group.bvids.some(needsAnalysis)) await sleepWhile(S.settings.triageIntervalSec * 1000, keepGoing);
  }
  group.running = false;
  S.status = "";
  render();
}

async function retry(bvid) {
  const r = await analyzeOne(bvid, true);
  if (!r.ok) {
    S.analyses[bvid] = { bvid, status: "error", error: r.error };
    if (r.code === "THROTTLED") toast("AI 限流，请稍后再试", true);
    else handleAiError(r.error);
  } else {
    S.analyses[bvid] = r.data;
  }
  render();
}

function nextGroup() {
  const old = S.group;
  if (old) old.stop = true;
  const bvids = proposeGroup(new Set(old?.bvids || []));
  if (!bvids.length) {
    S.group = null;
    S.tab = "unsure";
    toast("待定里没有需要细看的视频了");
    render();
    return;
  }
  startGroup(bvids);
}

function afterProcessedChange() {
  if (S.group && S.group.bvids.length && S.group.bvids.every(isProcessed)) {
    toast("本组已处理完，自动开始下一组");
    nextGroup();
  }
}

// ---------- basket ----------
const saveBasket = () => storeSet(K.basket, S.basket);

function toggleBasket(bvid) {
  const i = S.basket.findIndex((x) => x.bvid === bvid);
  const it = S.itemMap.get(bvid);
  if (i >= 0) {
    S.basket.splice(i, 1);
    toast("已移出摘录篮");
  } else if (it) {
    const a = S.analyses[bvid];
    const done = a?.status === "done";
    S.basket.push({
      bvid,
      title: it.title,
      url: videoUrl(bvid),
      upper: it.upper,
      oneLiner: done ? a.oneLiner || "" : "",
      points: done ? a.points || [] : [],
      note: ""
    });
    toast(`已加入摘录篮《${shortTitle(it)}》`);
  }
  saveBasket();
  renderBasket();
  render();
}

function renderBasket() {
  el.basketCount.textContent = S.basket.length;
  el.basketList.innerHTML = S.basket.length
    ? S.basket
        .map(
          (x, i) => `<div class="basket-item" data-i="${i}">
      <div class="row"><strong>${esc(x.title)}</strong><button type="button" data-basket="remove" aria-label="从摘录篮移除 ${esc(x.title)}">移除</button></div>
      ${x.oneLiner ? `<div class="muted">${esc(x.oneLiner)}</div>` : ""}
      <textarea data-basket="note" rows="2" placeholder="笔记" aria-label="笔记">${esc(x.note)}</textarea>
    </div>`
        )
        .join("")
    : `<p class="empty">按 E 把视频加入摘录篮</p>`;
  el.copyMdBtn.disabled = el.exportBtn.disabled = !S.basket.length;
}

function mdLinkText(s) {
  return String(s).replace(/([\[\]])/g, "\\$1");
}

function buildMarkdown(now = new Date()) {
  const lines = [
    "---",
    `title: B站摘录 ${stamp(now, false)} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    `created: ${stamp(now, false)}`,
    "tags:",
    "  - B站摘录",
    "---",
    ""
  ];
  for (const x of S.basket) {
    lines.push(`## [${mdLinkText(x.title)}](${x.url})`, "");
    if (x.upper) lines.push(`UP：${x.upper}`, "");
    if (x.oneLiner) lines.push(`> ${x.oneLiner}`, "");
    if (x.points?.length) lines.push(...x.points.map((p) => `- ${p}`), "");
    const names = tagIdsOf(x.bvid).map((id) => tagById(id).name);
    if (names.length) lines.push(`标签：${names.join("、")}`, "");
    if (x.note?.trim()) lines.push(`笔记：${x.note.trim()}`, "");
  }
  return lines.join("\n");
}

async function exportBasket() {
  el.exportBtn.disabled = true;
  const filename = `B站摘录-${stamp()}.md`;
  const r = await send({ type: "triage-export", filename, markdown: buildMarkdown() });
  el.exportBtn.disabled = false;
  if (!r.ok) {
    toast(`写入 Obsidian 失败：${r.error}`, true);
    return;
  }
  toast(`已写入 ${r.data?.path || filename}`);
  if (await askConfirm("清空摘录篮？", `<p>已写入 ${esc(r.data?.path || filename)}</p>`, "清空")) {
    S.basket = [];
    saveBasket();
    renderBasket();
    render();
  }
}

// ---------- data export ----------
const BACKUP_PREFIXES = ["triage_tags", "triage_video_tags", "triage_basket", "triage_snapshot_", "triage_decisions_", "triage_title_", "triage_analysis_"];
const isSecretKey = (k) => /key|token/i.test(k) || k === "aiProviderKeys" || k === "obsidianApiKey";

async function buildBackup() {
  const all = await chrome.storage.local.get(null);
  const out = {
    app: "bilidigest",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest?.().version || "",
    settings: {
      triageCriteria: S.settings.triageCriteria,
      triageIntervalSec: S.settings.triageIntervalSec,
      triageExportFolder: S.settings.triageExportFolder,
      triageTitleBatchSize: S.settings.triageTitleBatchSize
    },
    tags: [],
    videoTags: {},
    basket: [],
    folders: {},
    titleResults: {},
    analyses: {}
  };
  const folder = (id) =>
    (out.folders[id] ||= { title: S.folders.find((f) => String(f.id) === id)?.title || "", snapshot: null, decisions: {} });
  for (const [k, v] of Object.entries(all || {})) {
    if (!BACKUP_PREFIXES.some((p) => k.startsWith(p))) continue;
    if (isSecretKey(k)) continue; // defensive: triage keys never contain these words
    if (k === "triage_tags") out.tags = v;
    else if (k === "triage_video_tags") out.videoTags = v;
    else if (k === "triage_basket") out.basket = v;
    else if (k.startsWith("triage_snapshot_")) folder(k.slice(16)).snapshot = v;
    else if (k.startsWith("triage_decisions_")) folder(k.slice(17)).decisions = v;
    else if (k.startsWith("triage_title_")) out.titleResults[k.slice(13)] = v;
    else if (k.startsWith("triage_analysis_")) out.analyses[k.slice(16)] = v;
  }
  return out;
}

function csvField(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function buildCsv() {
  const folderTitle = S.folders.find((f) => String(f.id) === S.mediaId)?.title || "";
  const header = ["收藏夹", "BV号", "标题", "UP主", "时长", "链接", "AI判断", "判断来源", "理由", "一句话", "要点", "标签", "我的处理", "处理时间", "是否失效"];
  const rows = [header];
  for (const it of S.items) {
    const v = verdictOf(it);
    const a = S.analyses[it.bvid];
    const done = a?.status === "done";
    const d = S.decisions[it.bvid];
    rows.push([
      folderTitle,
      it.bvid,
      it.title,
      it.upper,
      fmtDuration(it.duration),
      videoUrl(it.bvid),
      v.verdict === "none" ? "" : VERDICT_LABEL[v.verdict],
      v.stage === 2 ? "字幕" : v.stage === 1 ? "标题" : "",
      v.reason,
      done ? a.oneLiner || "" : "",
      done ? (a.points || []).join(" | ") : "",
      tagIdsOf(it.bvid).map((id) => tagById(id).name).join("、"),
      d ? (d.action === "unfav" ? "取消收藏" : "保留") : "",
      d ? fmtTime(d.at) : "",
      it.invalid ? "是" : "否"
    ]);
  }
  return "﻿" + rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

function downloadText(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- events ----------
function bindEvents() {
  el.folderSelect.addEventListener("change", () => openFolder(el.folderSelect.value));
  el.refreshBtn.addEventListener("click", () => S.mediaId && syncFolder({ force: true }));
  const autoSync = () => {
    if (S.mediaId && document.visibilityState === "visible") syncFolder();
  };
  window.addEventListener("focus", autoSync);
  document.addEventListener("visibilitychange", autoSync);

  el.stage1Btn.addEventListener("click", () => {
    if (S.stage1.running) {
      S.stage1.stop = true;
      S.status = "粗分将在当前批次后暂停";
      renderStatus();
    } else runStage1();
  });
  el.groupBtn.addEventListener("click", () => {
    if (S.group?.running) {
      S.group.stop = true;
      S.status = "细看将在当前视频后暂停";
      renderStatus();
    } else if (S.group && S.group.bvids.some(needsAnalysis)) {
      S.tab = "group";
      render();
      runGroup();
    } else startGroup(proposeGroup(new Set(S.group?.bvids || [])));
  });

  el.tabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tab]");
    if (!btn) return;
    S.tab = btn.dataset.tab;
    if (S.tab !== "group") storeSet(K.tab, S.tab);
    S.focusIndex = 0;
    S.focused = "";
    el.list.scrollTop = 0;
    render();
  });
  el.tagFilter.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tagfilter]");
    if (!btn) return;
    const id = btn.dataset.tagfilter;
    if (S.tagFilter.has(id)) S.tagFilter.delete(id);
    else S.tagFilter.add(id);
    render();
  });

  el.listHeader.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-head]");
    if (!btn) return;
    const act = btn.dataset.head;
    if (act === "batch-unfav") batchUnfav(btn);
    else if (act === "batch-keep") batchKeep();
    else if (act === "next-group") nextGroup();
    else if (act === "clear-selected") {
      S.selected.clear();
      render();
    } else if (act === "end-group") {
      if (S.group) S.group.stop = true;
      S.group = null;
      S.tab = "unsure";
      render();
    }
  });

  el.list.addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (!card) return;
    const bvid = card.dataset.bvid;
    const act = e.target.closest("[data-act]")?.dataset.act;
    setFocus(bvid, false);
    if (act) cardAction(act, bvid);
  });

  document.addEventListener("keydown", onKey);

  el.settingsBtn.addEventListener("click", () => openSettings());
  for (const input of [el.thinkingInput, el.batchSizeInput, el.titleMaxInput, el.analyzeMaxInput]) {
    input.addEventListener("input", renderTokenHints);
  }
  el.settingsDialog.querySelector("form").addEventListener("submit", (e) => {
    if (e.submitter?.value !== "save") return;
    const bad = [el.titleMaxInput, el.analyzeMaxInput].filter((input) => parseMaxTokens(input.value) === null);
    el.settingsError.hidden = !bad.length;
    if (bad.length) {
      e.preventDefault();
      el.settingsError.textContent = "输出上限需为整数：0 或留空表示自动，否则在 200–32000 之间";
      bad[0].focus();
    }
  });
  el.settingsDialog.addEventListener("close", async () => {
    if (el.settingsDialog.returnValue !== "save") return;
    const patch = {
      triageCriteria: el.criteriaInput.value,
      triageIntervalSec: Math.max(0, Number(el.intervalInput.value) || 0),
      triageTitleBatchSize: Math.max(1, Math.min(100, Number(el.batchSizeInput.value) || 30)),
      triageExportFolder: el.exportFolderInput.value.trim(),
      triageThinking: el.thinkingInput.checked,
      triageTitleMaxTokens: parseMaxTokens(el.titleMaxInput.value),
      triageAnalyzeMaxTokens: parseMaxTokens(el.analyzeMaxInput.value)
    };
    const r = await send({ type: "triage-settings-save", ...patch });
    if (!r.ok) {
      toast(`保存设置失败：${r.error}`, true);
      return;
    }
    Object.assign(S.settings, patch);
    toast("设置已保存");
  });
  el.openOptionsBtn.addEventListener("click", () => send({ type: "open-options" }));
  el.backupBtn.addEventListener("click", async () => {
    try {
      downloadText(`BiliDigest备份-${stamp()}.json`, JSON.stringify(await buildBackup(), null, 2), "application/json");
    } catch (err) {
      toast(`导出备份失败：${err.message}`, true);
    }
  });
  el.csvBtn.addEventListener("click", () => {
    if (!S.items.length) {
      toast("当前收藏夹没有视频可导出", true);
      return;
    }
    const title = (S.folders.find((f) => String(f.id) === S.mediaId)?.title || S.mediaId).replace(/[\\/:*?"<>|]/g, "_");
    downloadText(`BiliDigest-${title}-${stamp(new Date(), false)}.csv`, buildCsv(), "text/csv;charset=utf-8");
  });
  el.helpBtn.addEventListener("click", () => el.helpDialog.showModal());

  el.syncViewBtn.addEventListener("click", () => (el.syncDetail.hidden = !el.syncDetail.hidden));
  el.syncCloseBtn.addEventListener("click", () => (el.syncNotice.hidden = true));

  // tag picker
  el.pickerInput.addEventListener("input", () => {
    picker.index = 0;
    renderPicker();
  });
  el.pickerInput.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // Enter confirms the IME candidate, not the tag
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = picker.options.length;
      if (n) picker.index = (picker.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      renderPicker();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pickOption(picker.index);
    }
  });
  el.pickerList.addEventListener("mousedown", (e) => {
    const li = e.target.closest("[data-i]");
    if (!li) return;
    e.preventDefault();
    picker.index = Number(li.dataset.i);
    pickOption(picker.index);
    el.pickerInput.focus();
  });
  el.pickerDialog.addEventListener("close", closePicker);

  // tag manager
  el.manageTagsBtn.addEventListener("click", () => {
    renderTagManager();
    el.tagsDialog.showModal();
  });
  el.tagsRows.addEventListener("change", (e) => {
    const row = e.target.closest(".tag-row");
    const t = row && tagById(row.dataset.id);
    if (!t) return;
    if (e.target.dataset.field === "color") t.color = e.target.value;
    if (e.target.dataset.field === "name") {
      const name = e.target.value.trim();
      if (!name || S.tags.some((x) => x !== t && x.name === name)) {
        toast(name ? "已有同名标签" : "标签名不能为空", true);
        e.target.value = t.name;
        return;
      }
      t.name = name;
    }
    saveTags();
    render();
  });
  el.tagsRows.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-field="delete"]');
    if (btn) deleteTag(btn.closest(".tag-row").dataset.id);
  });
  const addTag = () => {
    const name = el.newTagInput.value.trim();
    if (!name) return;
    createTag(name);
    el.newTagInput.value = "";
    renderTagManager();
    render();
  };
  el.addTagBtn.addEventListener("click", addTag);
  el.newTagInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    }
  });

  // basket
  el.basketToggle.addEventListener("click", () => {
    const collapsed = el.basket.classList.toggle("collapsed");
    el.basketToggle.setAttribute("aria-expanded", String(!collapsed));
  });
  if (matchMedia("(max-width: 899px)").matches) {
    el.basket.classList.add("collapsed");
    el.basketToggle.setAttribute("aria-expanded", "false");
  }
  el.basketList.addEventListener("click", (e) => {
    if (e.target.dataset.basket !== "remove") return;
    const i = Number(e.target.closest(".basket-item").dataset.i);
    S.basket.splice(i, 1);
    saveBasket();
    renderBasket();
    render();
  });
  el.basketList.addEventListener("input", (e) => {
    if (e.target.dataset.basket !== "note") return;
    S.basket[Number(e.target.closest(".basket-item").dataset.i)].note = e.target.value;
    saveBasket();
  });
  el.copyMdBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(buildMarkdown());
      toast("已复制 Markdown");
    } catch (err) {
      toast(`复制失败：${err.message}`, true);
    }
  });
  el.exportBtn.addEventListener("click", exportBasket);
}

// Returns 0 for auto, the integer for 200–32000, or null when invalid.
function parseMaxTokens(value) {
  const s = String(value ?? "").trim();
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isInteger(n)) return null;
  return n === 0 || (n >= 200 && n <= 32000) ? n : null;
}

function renderTokenHints() {
  const batch = Math.max(1, Number(el.batchSizeInput.value) || 30);
  const on = el.thinkingInput.checked;
  const titleAuto = on ? 150 * batch + 4000 : 60 * batch + 200;
  const analyzeAuto = on ? 8000 : 1000;
  el.titleMaxHint.textContent = `自动 = ${titleAuto}（每批 ${batch} 个，思考${on ? "开" : "关"}）`;
  el.analyzeMaxHint.textContent = `自动 = ${analyzeAuto}（思考${on ? "开" : "关"}）`;
}

function openSettings(scrollToAi = false) {
  el.criteriaInput.value = S.settings.triageCriteria || "";
  el.intervalInput.value = S.settings.triageIntervalSec ?? 3;
  el.batchSizeInput.value = S.settings.triageTitleBatchSize ?? 30;
  el.exportFolderInput.value = S.settings.triageExportFolder || "";
  el.thinkingInput.checked = Boolean(S.settings.triageThinking);
  el.titleMaxInput.value = S.settings.triageTitleMaxTokens || "";
  el.analyzeMaxInput.value = S.settings.triageAnalyzeMaxTokens || "";
  el.settingsError.hidden = true;
  renderTokenHints();
  el.settingsDialog.returnValue = "";
  el.settingsDialog.showModal();
  if (scrollToAi) el.aiDebugTitle.scrollIntoView({ block: "start" });
}

function cardAction(act, bvid) {
  const it = S.itemMap.get(bvid);
  if (!it) return;
  if (act === "open") openTab(videoUrl(bvid));
  else if (act === "unfav") decide(bvid, "unfav");
  else if (act === "keep") decide(bvid, "keep");
  else if (act === "tag") openPicker(bvid);
  else if (act === "accept") acceptSuggestions(bvid);
  else if (act === "basket") toggleBasket(bvid);
  else if (act === "retry") retry(bvid);
  else if (act === "select") {
    if (S.selected.has(bvid)) S.selected.delete(bvid);
    else if (S.selected.size >= SELECT_CAP) {
      toast(`一次最多选中 ${SELECT_CAP} 个`, true);
      return;
    } else S.selected.add(bvid);
    render();
  }
}

function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  if (document.querySelector("dialog[open]")) return;
  const t = e.target;
  if (t.closest?.("input, textarea, select, [contenteditable]")) return;
  if ((e.key === "Enter" || e.key === " ") && t.closest?.("button, a")) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const map = {
    j: () => moveFocus(1),
    ArrowDown: () => moveFocus(1),
    k: () => moveFocus(-1),
    ArrowUp: () => moveFocus(-1),
    "?": () => el.helpDialog.showModal(),
    u: () => undo()
  };
  const cardKeys = { d: "unfav", s: "keep", t: "tag", a: "accept", e: "basket", x: "select", o: "open", Enter: "open" };
  if (map[key]) map[key]();
  else if (cardKeys[key] && S.focused) cardAction(cardKeys[key], S.focused);
  else return;
  e.preventDefault();
}
