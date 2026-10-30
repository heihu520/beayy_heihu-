#!/usr/bin/env python3
"""查英文译文：app.js 里 tr("…") 的中文原句、显示时查译文的固定词（总结的类型和领域，读 Rust 源码），
在 locales/en.js 里有没有译文、占位符对不对得上。

用法：python3 app/ui/tools/查译文.py [--rest]
  缺译文或占位符对不上就列出来、退出码 1；表里有、代码里已经找不到的原句（改过文案留下的）也列出来，不算错。
  --rest：再列出代码里（注释以外）还带中文、又不在 tr() 里的行，逐条看是该翻还是故意留着（拿去比对的数据值、开发用的日志）。
"""
import json
import re
import sys
from pathlib import Path

UI = Path(__file__).resolve().parent.parent
HAN = re.compile(r"[一-鿿]")
STR = r'"((?:[^"\\\n]|\\.)*)"'
TR = re.compile(r"\btr\(\s*" + STR)


def load_en():
    text = (UI / "locales" / "en.js").read_text(encoding="utf-8")
    body = text[text.index("{", text.index("window.I18N_EN")): text.rindex("}") + 1]
    return json.loads(body)


def data_words():
    """界面显示时查译文的固定词：总结那边的类型（ACTIVITY_TREE）和领域（DOMAINS），以 Rust 为准"""
    rs = (UI.parent / "crates" / "beayy-summary" / "src" / "lib.rs").read_text(encoding="utf-8")
    words = set()
    for name in ("ACTIVITY_TREE", "DOMAINS"):
        m = re.search(r"pub const " + name + r"\b.*?;\n", rs, re.S)
        words |= set(re.findall(r'"([^"]+)"', m.group(0)))
    return words


def code_lines(text):
    """去掉注释后的每一行（行号从 1 起）：// 到行尾、/* … */ 跨行；字符串里的 // 不当注释"""
    out, in_block = [], False
    for no, line in enumerate(text.split("\n"), 1):
        buf, i, q = [], 0, None
        while i < len(line):
            c = line[i]
            if in_block:
                if line.startswith("*/", i): in_block = False; i += 2
                else: i += 1
                continue
            if q:
                buf.append(c)
                if c == "\\" and i + 1 < len(line): buf.append(line[i + 1]); i += 2; continue
                if c == q: q = None
                i += 1; continue
            if c in "\"'`": q = c; buf.append(c); i += 1; continue
            if line.startswith("//", i) and not (i and line[i - 1] == ":"): break
            if line.startswith("/*", i): in_block = True; i += 2; continue
            buf.append(c); i += 1
        if q == "`": q = None  # 跨行模板字符串：下一行接着当代码看
        out.append((no, "".join(buf)))
    return out


def main():
    en = load_en()
    js = (UI / "app.js").read_text(encoding="utf-8")
    keys = {json.loads('"' + m + '"') for m in TR.findall(js)} | data_words()
    html_keys = set()
    for no, line in code_lines((UI / "index.html").read_text(encoding="utf-8")):
        for m in re.findall(r'(?:title|aria-label)="([^"]*)"|>([^<>]+)<', line):
            k = (m[0] or m[1]).strip()
            if HAN.search(k): html_keys.add(k)
    bad = 0
    for k in sorted(keys | html_keys):
        if k not in en: print(f"缺译文：{k}"); bad += 1
    for k, v in en.items():
        want = set(re.findall(r"\{(\w+)\}", k))
        for form in (v.values() if isinstance(v, dict) else [v]):
            got = set(re.findall(r"\{(\w+)\}", form))
            if got - want: print(f"注意，译文用了原句没有的占位符（调用处要另传）：{k} → {form}")
    quoted = set(re.findall(STR, js))
    stale = [k for k in en if k not in keys | html_keys and json.dumps(k, ensure_ascii=False)[1:-1] not in quoted]
    for k in stale: print(f"代码里找不到（可删）：{k}")
    if "--rest" in sys.argv:
        for no, line in code_lines(js):
            rest = TR.sub("", line)
            if HAN.search(rest): print(f"app.js:{no}: {line.strip()[:160]}")
    print(f"tr() 原句和固定词 {len(keys)} 条＋页面 {len(html_keys)} 条，译文表 {len(en)} 条，缺 {bad} 处")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
