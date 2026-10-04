// 自動評価のベンチマーク：index.html の autoEval をそのまま呼び、
// 「答案らしくない入力」が低く、「論点を含む入力」が高く出るかを確かめる。
//   node tools/bench.mjs [yobi|shiho|kyushi] [--detail]
// 必要なもの：Node.js と playwright（Chromium）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exam = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "yobi";
const detail = process.argv.includes("--detail");

let chromium;
try { ({ chromium } = await import("playwright")); }
catch { ({ chromium } = await import("/opt/node22/lib/node_modules/playwright/index.mjs")); }

const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split("?")[0]).replace(/^\/$/, "/index.html"));
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": f.endsWith(".json") ? "application/json" : "text/html; charset=utf-8" });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.goto(`http://localhost:${port}/index.html`);
await page.waitForTimeout(500);

const result = await page.evaluate(async exam => {
  const data = await (await fetch(`${exam}-data.json`)).json();
  const ev = (ans, prob) => {
    const n = nfkc(ans);
    const arts = new Set(n.match(/[0-9]+条(?:の[0-9]+)?/g) || []).size;
    return autoEval(ans, CUR_SKEL, {finished: "完走", chars: charCount(ans), copy: prob ? copyRatio(ans, prob) : null, arts, prob});
  };
  let CUR_SKEL;
  const rows = [];
  for (const [year, rec] of Object.entries(data)) {
    for (const it of rec.items) {
      if (!it.skel || it.skel.source !== "curated") continue;
      CUR_SKEL = it.skel;
      const labels = it.skel.pillars.map(p => p.label).join("。\n") + "。";
      const cases = {
        // 低く出るべきもの
        problem: ev(it.problem, it.problem),
        // 高く出るべきもの（出題趣旨は論点をすべて含む）
        shushi: ev(it.shushi || "", it.problem),
        // 論点名だけを並べたもの（当てはめなし・分量不足）
        labels: ev(labels, it.problem),
      };
      rows.push({year, id: it.id, ...Object.fromEntries(Object.entries(cases).map(([k, e]) => [k, {score: e.score, cov: e.cov, band: e.band}]))});
    }
  }
  return rows;
}, exam);

const cases = ["problem", "shushi", "labels"];
const want = { problem: "低いほどよい", shushi: "高いほどよい", labels: "A圏にならないこと" };
console.log(`${exam}: 精選キーワードのある ${result.length} 問`);
for (const c of cases) {
  const sc = result.map(r => r[c].score), cv = result.map(r => r[c].cov);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const bands = {};
  result.forEach(r => bands[r[c].band] = (bands[r[c].band] || 0) + 1);
  console.log(`  ${c.padEnd(8)} 論点カバー平均 ${(mean(cv) * 100).toFixed(0)}%・総合平均 ${(mean(sc) * 100).toFixed(0)}点  ${JSON.stringify(bands)}  （${want[c]}）`);
}
if (detail) {
  console.log("\n問題文コピーで論点カバー30%以上：");
  result.filter(r => r.problem.cov >= .3).sort((a, b) => b.problem.cov - a.problem.cov)
    .forEach(r => console.log(`  ${r.year} ${r.id} ${(r.problem.cov * 100).toFixed(0)}%`));
  console.log("\n出題趣旨で論点カバー60%未満：");
  result.filter(r => r.shushi.cov < .6).sort((a, b) => a.shushi.cov - b.shushi.cov)
    .forEach(r => console.log(`  ${r.year} ${r.id} ${(r.shushi.cov * 100).toFixed(0)}%`));
}
// 手書きの答案（tools/fixtures）で、評価が期待どおりの帯に入るか
const fx = JSON.parse(fs.readFileSync(path.join(root, "tools/fixtures/fixtures.json"), "utf8"));
let fail = 0;
console.log("\n答案サンプル：");
for (const f of fx) {
  const ans = fs.readFileSync(path.join(root, "tools/fixtures", f.file), "utf8");
  // pass：合格答案として比べる答案（tools/fixtures のファイル名）
  const pass = (f.pass || []).map(n => fs.readFileSync(path.join(root, "tools/fixtures", n), "utf8"));
  const e = await page.evaluate(async ({f, ans, pass}) => {
    const data = await (await fetch(`${f.exam}-data.json`)).json();
    const it = data[f.year].items.find(x => x.id === f.id);
    const arts = new Set(nfkc(ans).match(/[0-9]+条(?:の[0-9]+)?/g) || []).size;
    const r = autoEval(ans, it.skel, {finished: f.finished, chars: charCount(ans), copy: copyRatio(ans, it.problem), arts, prob: it.problem, pass});
    return {band: r.band, score: r.score, cov: r.cov, why: r.why, pil: r.pil.map(p => ["×", "△", "◯"][p.level] + p.label + (p.passN ? `（合格答案 ${p.passHit}/${p.passN}${p.bonus ? "・加点" : ""}）` : ""))};
  }, {f, ans, pass});
  const ok = f.expect.includes(e.band);
  if (!ok) fail++;
  console.log(`  ${ok ? "OK  " : "NG  "}${f.file}：${e.band}（総合${Math.round(e.score * 100)}点・論点カバー${Math.round(e.cov * 100)}%）期待 ${f.expect.join("か")}　${f.memo}${pass.length ? `（合格答案${pass.length}通と比較）` : ""}`);
  if (!ok || detail) { e.pil.forEach(p => console.log("        " + p)); e.why.forEach(w => console.log("        ・" + w)); }
}
if (errors.length) console.log("page errors:", errors);
if (fail) process.exitCode = 1;
await browser.close();
server.close();
