"""デスクトップに置いてダブルクリックで開ける1ファイル版を作る。

過去問データ（exams-index.json・yobi/shiho/kyushi-data.json）を HTML の中に入れるので、
インターネットにつながっていなくても過去問の読み込みと自動評価が使える
（AIの添削だけは「設定」のAPIキーか「プロンプトをコピー」を使う）。

    python3 tools/build_desktop.py 出力先.html [--extra 問題データ.json] [--pass 合格答案.json ...]

--extra  自分用の問題データ（{"kind":"problems",...}）。年度の一覧に「自分用データ」として出る
--pass   合格答案ライブラリ（書き出したJSONの配列）。何個でも指定できる。「同梱」として出る
自分用のデータを入れたファイルは、公開しないこと。
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ["exams-index.json", "yobi-data.json", "shiho-data.json", "kyushi-data.json"]

ap = argparse.ArgumentParser()
ap.add_argument("out")
ap.add_argument("--extra")
ap.add_argument("--pass", dest="passes", action="append", default=[])
a = ap.parse_args()


def block(name, obj):
    # </script> で途切れないように "</" を JSON のエスケープ "<\/" にする
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    return f'<script type="application/json" id="embed:{name}">{text}</script>\n'


blocks = [block(n, json.loads((ROOT / n).read_text(encoding="utf-8"))) for n in DATA]
if a.extra:
    blocks.append(block("extra-problems.json", json.loads(Path(a.extra).read_text(encoding="utf-8"))))
if a.passes:
    lib, seen = [], set()
    for p in a.passes:
        for x in json.loads(Path(p).read_text(encoding="utf-8")):
            if isinstance(x, dict) and x.get("id") and x.get("key") and x.get("text") and x["id"] not in seen:
                seen.add(x["id"]); lib.append(x)
    blocks.append(block("pass-library.json", lib))

src = (ROOT / "index.html").read_text(encoding="utf-8")
if src.count("<body>") != 1:
    raise SystemExit("<body> が見つからない")
out = src.replace("<body>", "<body>\n" + "".join(blocks), 1)
Path(a.out).write_text(out, encoding="utf-8")
print(f"{a.out}（{len(out.encode()):,} バイト）")
