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
    return autoEval(ans, CUR_SKEL, {finished: "完走", chars: charCount(ans), copy: prob ? copyRatio(ans, prob) : null, arts, prob, refChars: refCharsFor(CUR_ITEM, exam)});
  };
  let CUR_SKEL, CUR_ITEM;
  const rows = [];
  for (const [year, rec] of Object.entries(data)) {
    for (const it of rec.items) {
      if (!it.skel || it.skel.source !== "curated") continue;
      CUR_SKEL = it.skel; CUR_ITEM = it;
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
    const r = autoEval(ans, it.skel, {finished: f.finished, chars: charCount(ans), copy: copyRatio(ans, it.problem), arts, prob: it.problem, refChars: refCharsFor(it, f.exam), pass});
    return {band: r.band, score: r.score, cov: r.cov, why: r.why, pil: r.pil.map(p => ["×", "△", "◯"][p.level] + p.label + (p.passN ? `（合格答案 ${p.passHit}/${p.passN}${p.bonus ? "・加点" : ""}）` : ""))};
  }, {f, ans, pass});
  const ok = f.expect.includes(e.band);
  if (!ok) fail++;
  console.log(`  ${ok ? "OK  " : "NG  "}${f.file}：${e.band}（総合${Math.round(e.score * 100)}点・論点カバー${Math.round(e.cov * 100)}%）期待 ${f.expect.join("か")}　${f.memo}${pass.length ? `（合格答案${pass.length}通と比較）` : ""}`);
  if (!ok || detail) { e.pil.forEach(p => console.log("        " + p)); e.why.forEach(w => console.log("        ・" + w)); }
}
// 評価つきの再現答案（合格答案ライブラリから書き出したJSON。リポジトリには入れない）で、実際の評価との一致を測る
//   node tools/bench.mjs yobi --real 合格答案.json
const realAt = process.argv.indexOf("--real");
if (realAt > 0 && process.argv[realAt + 1]) {
  const lib = JSON.parse(fs.readFileSync(process.argv[realAt + 1], "utf8")).filter(x => /^[A-F]$/.test(x.rank) && x.key.startsWith(exam + "/"));
  const rows = await page.evaluate(async ({exam, lib}) => {
    const data = await (await fetch(`${exam}-data.json`)).json();
    return lib.map(x => {
      const [, year, id] = x.key.split("/");
      const it = data[year] && data[year].items.find(i => i.id === id);
      if (!it || !it.skel) return null;
      const arts = new Set(nfkc(x.text).match(/[0-9]+条(?:の[0-9]+)?/g) || []).size;
      const e = autoEval(x.text, it.skel, {finished: "完走", chars: charCount(x.text), copy: copyRatio(x.text, it.problem), arts, prob: it.problem, refChars: refCharsFor(it, exam), pass: []});
      return {key: x.key, rank: x.rank, score: e.score, band: e.band};
    }).filter(Boolean);
  }, {exam, lib});
  const RK = {A: 5, B: 4, C: 3, D: 2, E: 1, F: 0};
  const rk = a => { const s = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]), r = Array(a.length); let i = 0; while (i < s.length) { let j = i; while (j + 1 < s.length && s[j + 1][0] === s[i][0]) j++; for (let k = i; k <= j; k++) r[s[k][1]] = (i + j) / 2; i = j + 1; } return r; };
  const spear = (a, b) => { const ra = rk(a), rb = rk(b), n = a.length, m = (n - 1) / 2; let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (ra[i] - m) * (rb[i] - m); va += (ra[i] - m) ** 2; vb += (rb[i] - m) ** 2; } return c / Math.sqrt(va * vb); };
  let ok = 0, tot = 0;
  for (const a of rows) for (const b of rows) if (a.key === b.key && RK[a.rank] >= 4 && RK[b.rank] <= 2) { tot++; ok += a.score > b.score ? 1 : a.score === b.score ? .5 : 0; }
  console.log(`\n評価つき再現答案 ${rows.length}通：実際の評価との順位相関 ${spear(rows.map(r => RK[r.rank]), rows.map(r => r.score)).toFixed(2)}・同じ問題のA/B答案とD〜F答案を正しく並べた割合 ${tot ? Math.round(ok / tot * 100) : "—"}%（${tot}組）`);
  for (const band of ["A圏", "B圏", "C圏", "D〜F圏"]) {
    const R = rows.filter(r => r.band === band), c = k => R.filter(r => k.includes(r.rank)).length;
    console.log(`  ${band.padEnd(4)} ${R.length}通：実際にA・B ${R.length ? Math.round(c("AB") / R.length * 100) : 0}%・C ${R.length ? Math.round(c("C") / R.length * 100) : 0}%・D〜F ${R.length ? Math.round(c("DEF") / R.length * 100) : 0}%`);
  }
}
if (errors.length) console.log("page errors:", errors);
if (fail) process.exitCode = 1;
await browser.close();
server.close();
