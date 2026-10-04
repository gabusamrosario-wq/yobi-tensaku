"""claude.ai のアーティファクト用に index.html を変換する。

アーティファクトは公開時に <!doctype html><html><head><body> の骨組みで包まれるので、
index.html から骨組みのタグを外したものを出力する（中身は同じ）。

    python3 tools/build_artifact.py 出力先.html
"""
import re
import sys
from pathlib import Path

src = (Path(__file__).resolve().parent.parent / "index.html").read_text(encoding="utf-8")
out = src
for pat in [r"<!doctype html>\s*", r'<html lang="ja">\s*', r"<head>\s*", r'<meta charset="utf-8">\s*',
            r'<meta name="viewport"[^>]*>\s*', r'<meta name="description"[^>]*>\s*', r"</head>\s*", r"<body>\s*",
            r"</body>\s*", r"</html>\s*"]:
    out, n = re.subn(pat, "", out, count=1, flags=re.I)
    if n != 1:
        sys.exit(f"見つからない：{pat}")
Path(sys.argv[1]).write_text(out, encoding="utf-8")
print(f"{sys.argv[1]}（{len(out.encode()):,} バイト）")
