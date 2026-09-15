// Dev-only fake chrome.* for opening triage.html from a static server. No-op inside the real extension.
(() => {
  if (globalThis.chrome?.runtime?.id) return;

  globalThis.__TRIAGE_THROTTLE_MS = 5000; // real page waits 10 min
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const clone = (v) => (v === undefined ? v : structuredClone(v));

  // ----- storage -----
  const store = { aiProviderKeys: { openai: "sk-should-never-export" }, obsidianApiKey: "secret-token" };
  function makeArea(data) {
    return {
      async get(keys) {
        await wait(5);
        if (keys == null) return clone(data);
        const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = {};
        for (const k of list) {
          if (k in data) out[k] = clone(data[k]);
          else if (typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k];
        }
        return out;
      },
      async set(obj) {
        Object.assign(data, clone(obj));
      },
      async remove(keys) {
        for (const k of [].concat(keys)) delete data[k];
      }
    };
  }

  // ----- fake data -----
  const titles = [
    "从零实现一个 Transformer：逐行代码讲解", "Claude Code 实战：用 Agent 重构遗留项目", "【合集】吴恩达机器学习 2024 中文字幕",
    "RAG 到底怎么做才靠谱？踩坑三个月的总结", "大模型推理加速：vLLM 原理解析", "一口气看完 AI 圈本周新闻",
    "LoRA 微调手把手：8G 显存也能跑", "已失效视频", "Prompt 工程已死？聊聊上下文工程",
    "用 Cursor 写一个完整的记账 App", "深度学习数学基础：矩阵求导速通", "【直播回放】AI 创业者圆桌讨论 3 小时",
    "MCP 协议是什么？10 分钟讲清楚", "开源模型横评：Qwen / Llama / DeepSeek", "我用 AI 做了 100 天自媒体的真实收入",
    "Diffusion 模型原理图解", "Obsidian + AI 打造第二大脑", "搞笑配音：当 ChatGPT 学会了东北话",
    "向量数据库选型对比", "已失效视频", "强化学习入门：从多臂老虎机到 PPO",
    "AI Agent 设计模式 12 讲（第 1 讲）", "三分钟看懂 Sora 技术报告", "程序员会被 AI 取代吗？",
    "LangGraph 构建多智能体工作流", "【教程】本地部署 DeepSeek R1", "AI 绘画商业变现全攻略",
    "评测：十款 AI 编程助手哪家强", "注意力机制可视化讲解", "Kaggle 金牌方案复盘",
    "我的 AI 工作流分享（2025 版）", "模型量化 GPTQ / AWQ 对比", "闲聊：做 AI 产品的一年",
    "已失效视频", "Embedding 模型怎么选", "神经网络反向传播手推",
    "AI 写论文靠谱吗？实测", "如何评估大模型：Benchmark 的坑", "Function Calling 实战", "年度 AI 回顾"
  ];
  const uppers = ["跟李沐学AI", "技术蛋老师", "林亦LYi", "秋葉aaaki", "差评君", "3Blue1Brown官方", "硬核的半佛仙人", "Ele实验室"];
  const cover = (i) =>
    "data:image/svg+xml," +
    encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="hsl(${(i * 47) % 360},45%,60%)"/><text x="80" y="54" font-size="22" text-anchor="middle" fill="white">${i + 1}</text></svg>`);
  let seq = 0;
  function makeItem(title) {
    const i = seq++;
    const invalid = title === "已失效视频";
    return {
      bvid: `BV1mock${String(i).padStart(4, "0")}`,
      aid: 900000 + i,
      title,
      cover: cover(i),
      upper: invalid ? "" : uppers[i % uppers.length],
      duration: 120 + ((i * 397) % 3600),
      pubdate: 1717000000 + i * 86400,
      favTime: 1720000000 + i * 3600,
      intro: invalid ? "" : `这是《${title}》的简介。`,
      invalid,
      _i: i
    };
  }

  const folders = [
    { id: 1001, title: "稍后-AI", items: titles.map(makeItem) },
    { id: 1002, title: "学习", items: ["线性代数的本质 01", "费曼学习法", "如何高效读论文", "统计学习方法导读", "英语听力训练"].map(makeItem) },
    { id: 1003, title: "默认收藏夹", items: [] }
  ];
  const removed = new Map(); // aid -> { folder, item, index }
  const throttledOnce = new Set();
  let lastMediaId = 1001;
  let aiCommandCalls = 0;

  const findItem = (bvid) => folders.flatMap((f) => f.items).find((it) => it.bvid === bvid) || [...removed.values()].find((r) => r.item.bvid === bvid)?.item;
  const pub = ({ _i, ...rest }) => rest;
  const noAi = () => ({ ok: false, error: "还没有可用的模型，请先配置 AI 服务" });

  // ----- handlers -----
  const handlers = {
    "triage-folders": () => ({ ok: true, data: { mid: 12345, folders: folders.map((f) => ({ id: f.id, title: f.title, count: f.items.length })) } }),
    "triage-folder-items": ({ mediaId }) => {
      const f = folders.find((x) => String(x.id) === String(mediaId));
      if (!f) return { ok: false, error: "收藏夹不存在" };
      lastMediaId = f.id;
      return { ok: true, data: { items: f.items.map(pub) } };
    },
    "triage-title-get": ({ bvids }) => ({ ok: true, data: Object.fromEntries(bvids.map((b) => [b, store[`triage_title_${b}`] || null])) }),
    "triage-analysis-get": ({ bvids }) => ({ ok: true, data: Object.fromEntries(bvids.map((b) => [b, store[`triage_analysis_${b}`] || null])) }),
    "triage-classify-titles": async ({ items, tags }) => {
      await wait(400);
      if (globalThis.__mockNoAI) return noAi();
      const results = {};
      for (const { bvid } of items) {
        const i = findItem(bvid)._i;
        const verdict = ["keep", "drop", "unsure", "unsure", "keep"][i % 5];
        const suggestedTags = [];
        if (tags.length) suggestedTags.push(tags[i % tags.length].name);
        if (i % 6 === 0) suggestedTags.push("新:大模型");
        if (i % 9 === 0) suggestedTags.push("新:工具");
        const r = { verdict, reason: { keep: "标题显示为系统教程", drop: "资讯/娱乐类，时效性强", unsure: "标题信息不足" }[verdict], suggestedTags, confidence: i % 7 === 0 ? "low" : "high" };
        results[bvid] = r;
        store[`triage_title_${bvid}`] = r;
      }
      return { ok: true, data: { results } };
    },
    "triage-analyze": async ({ bvid, tags = [] }) => {
      await wait(300);
      if (globalThis.__mockNoAI) return noAi();
      const it = findItem(bvid);
      if (it._i === 2) return { ok: false, error: "字幕获取失败：网络超时" };
      if (it._i === 8 && !throttledOnce.has("truncate")) {
        throttledOnce.add("truncate");
        return { ok: false, error: "模型输出被截断（max_tokens 不足）" };
      }
      if (it._i === 3 && !throttledOnce.has(bvid)) {
        throttledOnce.add(bvid);
        return { ok: false, error: "请求过于频繁", code: "THROTTLED" };
      }
      const verdict = ["keep", "drop", "unsure"][it._i % 3];
      const a = {
        bvid,
        status: "done",
        source: it._i % 2 ? "subtitle" : "meta",
        oneLiner: `${it.title.slice(0, 12)}：核心观点是先理解原理再动手。`,
        points: ["讲清了基本概念和适用场景", "给出了一个可运行的完整示例", "最后总结了常见误区"],
        verdict,
        reason: { keep: "有可复用的方法论", drop: "内容浅，信息量低", unsure: "部分有用，需要自己判断" }[verdict],
        suggestedTags: [tags[0]?.name, "新:深度"].filter(Boolean),
        model: "mock-model",
        analyzedAt: Date.now()
      };
      store[`triage_analysis_${bvid}`] = a;
      return { ok: true, data: a };
    },
    "triage-ai-command": async ({ tags, items, allowNewTags, maxNewTags, allowVerdict }) => {
      await wait(300);
      aiCommandCalls++;
      if (aiCommandCalls === 2) return { ok: false, error: "模型返回的 JSON 无法解析" };
      const depth = (title) => (/入门|手把手|速通|三分钟|10 分钟|是什么/.test(title) ? "入门" : /原理|数学|手推|推导|解析|可视化/.test(title) ? "硬核" : "");
      const newTags = [];
      if (allowNewTags) {
        for (const [name, description] of [["入门", "零基础能看懂"], ["硬核", "需要数学或源码基础"]].slice(0, maxNewTags)) {
          if (!tags.some((t) => t.name === name)) newTags.push({ name, description });
        }
      }
      const allowed = new Set([...tags.map((t) => t.name), ...newTags.map((t) => t.name)]);
      const assignments = {};
      let verdictChanged = false;
      items.forEach((it, i) => {
        const add = [];
        const d = depth(it.title);
        if (d && allowed.has(d)) add.push(d);
        if (tags.length && i % 3 === 0) add.push(tags[i % tags.length].name);
        const remove = it.currentTags && i % 4 === 0 ? [it.currentTags[0]] : [];
        const a = { add, remove, reason: d ? `标题显示为${d}内容` : "按指令归类" };
        if (allowVerdict && !verdictChanged && it.verdict && it.verdict !== "keep") {
          a.verdict = "keep";
          a.reason = "指令认为值得保留";
          verdictChanged = true;
        }
        if (add.length || remove.length || a.verdict) assignments[it.bvid] = a;
      });
      return { ok: true, data: { newTags, assignments, note: `按指令处理了 ${items.length} 个视频` } };
    },
    "triage-unfav": ({ mediaId, aids }) => {
      const f = folders.find((x) => String(x.id) === String(mediaId));
      for (const aid of aids) {
        const index = f.items.findIndex((it) => it.aid === aid);
        if (index >= 0) removed.set(aid, { folder: f, item: f.items.splice(index, 1)[0], index });
      }
      return { ok: true, data: { done: aids.length } };
    },
    "triage-refav": ({ aid }) => {
      const r = removed.get(aid);
      if (!r) return { ok: false, error: "找不到要恢复的视频" };
      r.folder.items.splice(Math.min(r.index, r.folder.items.length), 0, r.item);
      removed.delete(aid);
      return { ok: true, data: { done: 1 } };
    },
    "triage-settings-get": () => ({
      ok: true,
      data: { triageCriteria: "只保留 AI 工程实践相关的深度内容，资讯和娱乐可以删", triageIntervalSec: 1, triageExportFolder: "B站摘录", triageTitleBatchSize: 15, triageThinking: false, triageTitleMaxTokens: 0, triageAnalyzeMaxTokens: 0, ...store.__settings }
    }),
    "triage-settings-save": ({ type, ...patch }) => {
      store.__settings = { ...store.__settings, ...patch };
      return { ok: true, data: store.__settings };
    },
    "triage-export": ({ filename, markdown }) => {
      globalThis.__mockExported = { filename, markdown };
      return { ok: true, data: { path: `B站摘录/${filename}` } };
    },
    "open-options": () => {
      console.info("[mock] open-options");
      return { ok: true };
    }
  };

  // Simulates changes made directly on Bilibili: remove 2, add 3, re-favorite 1 unfavorited, 1 newly invalid.
  globalThis.__mockSimulateBiliChange = () => {
    const f = folders.find((x) => x.id === lastMediaId);
    const victims = f.items.filter((it) => !it.invalid).slice(-2);
    f.items = f.items.filter((it) => !victims.includes(it));
    f.items.unshift(...["新收藏：Agent 记忆系统设计", "新收藏：AI 播客剪辑技巧", "新收藏：多模态模型综述"].map(makeItem));
    const back = [...removed.entries()].find(([, r]) => r.folder === f);
    if (back) handlers["triage-refav"]({ aid: back[0] });
    const flip = f.items.find((it) => !it.invalid && it._i > 30 && it._i < titles.length);
    if (flip) {
      flip.invalid = true;
      flip.title = "已失效视频";
    }
    return { removed: victims.map((it) => it.title), reAdded: back?.[1].item.title || null };
  };

  const prev = globalThis.chrome || {};
  globalThis.chrome = Object.assign(prev, {
    runtime: {
      id: undefined,
      lastError: undefined,
      getManifest: () => ({ version: "dev" }),
      getURL: (p) => new URL(`../${p}`, location.href).href,
      sendMessage(msg, cb) {
        (async () => {
          await wait(150);
          const h = handlers[msg?.type];
          const resp = h ? await h(clone(msg)) : { ok: false, error: `mock: 未知消息 ${msg?.type}` };
          cb?.(clone(resp));
        })();
      }
    },
    tabs: {
      create({ url }) {
        (globalThis.__mockOpened ||= []).push(url);
        console.info("[mock] tabs.create", url);
      }
    },
    storage: { local: makeArea(store), sync: makeArea({}) }
  });
  console.info("[mock] chrome API mocked for triage dev");
})();
