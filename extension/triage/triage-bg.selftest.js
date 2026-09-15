// node extension/triage/triage-bg.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const assert = require("assert");

const ctx = vm.createContext({ TextEncoder, URLSearchParams, console });
vm.runInContext(fs.readFileSync(path.join(__dirname, "triage-bg.js"), "utf8"), ctx);
const t = ctx;
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

// MD5
assert.strictEqual(t.triageMd5(""), "d41d8cd98f00b204e9800998ecf8427e");
assert.strictEqual(t.triageMd5("abc"), "900150983cd24fb0d6963f7d28e17f72");
for (const s of ["a".repeat(55), "a".repeat(56), "a".repeat(64), "中文字幕 w_rid", "x".repeat(1000)]) {
  assert.strictEqual(t.triageMd5(s), md5(s), `md5 len ${s.length}`);
}

// WBI
const mixinKey = t.triageMixinKey(
  "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
  "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png"
);
assert.strictEqual(mixinKey.length, 32);
const params = { bvid: "BV1g1dLBPEHV", cid: 37589944385, aid: 116420927166252, foo: "a!b'(c)*d 中" };
const wts = 1700000000;
const expectedQuery = "aid=116420927166252&bvid=BV1g1dLBPEHV&cid=37589944385&foo=abcd%20%E4%B8%AD&wts=1700000000";
assert.strictEqual(t.triageWbiSign(params, mixinKey, wts), `${expectedQuery}&w_rid=${md5(expectedQuery + mixinKey)}`);

// track pick
assert.strictEqual(t.triagePickTrack([{ lan: "ai-zh", subtitle_url: "a" }, { lan: "zh-CN", subtitle_url: "b" }]).subtitle_url, "b");
assert.strictEqual(t.triagePickTrack([{ lan: "ai-en", subtitle_url: "a" }, { lan: "ai-zh", subtitle_url: "b" }]).subtitle_url, "b");
assert.strictEqual(t.triagePickTrack([{ lan: "ai-en", subtitle_url: "a" }]), null);
assert.strictEqual(t.triagePickTrack(undefined), null);

// subtitle validation
const body = (to) => [{ from: 0, to: 1 }, { from: 1, to }];
assert.strictEqual(t.triageSubtitleValid(body(272.8), 273), true);
assert.strictEqual(t.triageSubtitleValid(body(283), 273), true);
assert.strictEqual(t.triageSubtitleValid(body(283.1), 273), false);
assert.strictEqual(t.triageSubtitleValid(body(136.5), 273), true);
assert.strictEqual(t.triageSubtitleValid(body(100), 273), false);
assert.strictEqual(t.triageSubtitleValid([], 273), false);
assert.strictEqual(t.triageSubtitleValid(null, 273), false);

// clip
assert.strictEqual(t.triageClip("a".repeat(12000)).length, 12000);
const clipped = t.triageClip("a".repeat(8000) + "b".repeat(5000) + "c".repeat(4000));
assert.strictEqual(clipped.length, 8000 + 2 + 4000);
assert.ok(clipped.startsWith("a".repeat(8000) + "……c"));

// LLM parse
const good = t.triageParseLlm('```json\n{"one_liner":"讲 X","points":["1","2","3"],"verdict":"keep","reason":"有方法"}\n```');
assert.deepStrictEqual(JSON.parse(JSON.stringify(good)), { oneLiner: "讲 X", points: ["1", "2", "3"], verdict: "keep", reason: "有方法", suggestedTags: [] });
const dirty = t.triageParseLlm('好的，结果如下：{"one_liner":"含 } 括号","points":["a","b","c","d"],"verdict":"DROP","reason":"r"} 以上');
assert.strictEqual(dirty.oneLiner, "含 } 括号");
assert.strictEqual(dirty.points.length, 3);
assert.strictEqual(dirty.verdict, "drop");
const thin = t.triageParseLlm('{"one_liner":"x","points":["only"],"verdict":"maybe"}');
assert.deepStrictEqual([...thin.points], ["only", "", ""]);
assert.strictEqual(thin.verdict, "unsure");
assert.strictEqual(thin.reason, "");
assert.throws(() => t.triageParseLlm('{"one_liner":"x","points":["a"'), /不完整/);
assert.throws(() => t.triageParseLlm("没有 JSON"), /不是 JSON/);
assert.throws(() => t.triageParseLlm('{"points":[]}'), /one_liner/);

// stage-2 tags
const tagList = ["AI", "编程", "理财"];
const withTags = t.triageParseLlm('{"one_liner":"x","points":["a","b","c"],"verdict":"keep","tags":["AI","不存在","新:数学","新:物理","编程","理财"]}', tagList);
assert.deepStrictEqual([...withTags.suggestedTags], ["AI", "新:数学", "编程"]);
assert.deepStrictEqual([...t.triageParseLlm('{"one_liner":"x","points":[]}', tagList).suggestedTags], []);

// tag coercion
assert.deepStrictEqual([...t.triageCoerceTags(["新：数学", "AI", "AI"], tagList, 2)], ["新:数学", "AI"]);
assert.deepStrictEqual([...t.triageCoerceTags(["新:", "乱写"], tagList, 2)], []);

// title line
assert.strictEqual(
  t.triageTitleLine({ title: "a|b\nc", upper: "UP", duration: 125, intro: "简".repeat(80) }, 3),
  `3|a b c|UP|2:05|${"简".repeat(60)}`
);

// stage-1 title batch
const items = [{ bvid: "BV1" }, { bvid: "BV2" }, { bvid: "BV3" }];
const batch = JSON.parse(JSON.stringify(t.triageParseTitleBatch(
  '好的：\n```json\n[{"i":2,"verdict":"KEEP","reason":"教程 [实用]","tags":["编程","新:算法","新:数据结构","AI"],"confidence":"high"},' +
    '{"i":1,"verdict":"what","reason":"看不出","tags":["不存在"],"confidence":"medium"},{"i":9,"verdict":"drop"}]\n```',
  items,
  tagList
)));
assert.deepStrictEqual(batch.BV2, { verdict: "keep", reason: "教程 [实用]", suggestedTags: ["编程", "新:算法"], confidence: "high" });
assert.deepStrictEqual(batch.BV1, { verdict: "unsure", reason: "看不出", suggestedTags: [], confidence: "low" });
assert.deepStrictEqual(batch.BV3, { verdict: "unsure", reason: "AI 未返回", suggestedTags: [], confidence: "low" });
assert.throws(() => t.triageParseTitleBatch('[{"i":1,"verdict":"keep"', items, tagList), /不完整/);

// form
assert.strictEqual(t.triageForm({ resources: "1:2,3:2", csrf: "x y", privacy: 1 }), "resources=1%3A2%2C3%3A2&csrf=x+y&privacy=1");

// output limits: custom wins, else auto by thinking
const off = { triageThinking: false, triageTitleMaxTokens: 0, triageAnalyzeMaxTokens: 0 };
const on = { ...off, triageThinking: true };
assert.strictEqual(t.triageMaxTokens("title", 30, off), 2000);
assert.strictEqual(t.triageMaxTokens("title", 30, on), 8500);
assert.strictEqual(t.triageMaxTokens("analyze", 1, off), 1000);
assert.strictEqual(t.triageMaxTokens("analyze", 1, on), 8000);
assert.strictEqual(t.triageMaxTokens("title", 30, { ...on, triageTitleMaxTokens: 5000 }), 5000);
assert.strictEqual(t.triageMaxTokens("analyze", 1, { ...off, triageAnalyzeMaxTokens: 2500.7 }), 2500);

console.log("triage-bg selftest: all passed");
