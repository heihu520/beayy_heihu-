#!/usr/bin/env python3
"""把设计系统「Beayy」（原名墨线，源文件夹仍叫 墨线）拷进网页界面：tokens.json → vendor/moxian/tokens.css，components/bundle.css 原样拷贝，
插画（components/Illustration/preview.html 里带 data-illus 的 SVG）抽成 vendor/moxian/illus.js（window.MX_ILLUS，按名字取）。

Tauri 只能读 app/ui/ 里面的文件，所以拷一份进来（不走打包工具）。设计系统改了就重跑一次再提交。
用法：python3 app/ui/tools/同步墨线.py
"""
import json
import re
import shutil
from pathlib import Path

UI = Path(__file__).resolve().parents[1]
SRC = UI.parents[1] / "设计系统/墨线/project"
OUT = UI / "vendor/moxian"


def vals(tok):
    v = tok["value"]
    return (v, v) if isinstance(v, str) else (v.get("light"), v.get("dark", v.get("light")))


def main():
    t = json.loads((SRC / "tokens.json").read_text(encoding="utf-8"))
    light, dark = [], []
    for tok in t["color"]["tokens"]:
        l, d = vals(tok)
        light.append(f"  --{tok['name']}: {l};")
        if d != l:
            dark.append(f"  --{tok['name']}: {d};")
    for name, fam in t["type"]["families"].items():
        light.append(f"  --font-{name}: {fam};")
    for family in ("spacing", "radius", "size"):
        for tok in t.get(family, {}).get("tokens", []):
            light.append(f"  --{tok['name']}: {tok['value']};")
    for tok in t.get("shadow", {}).get("tokens", []):
        l, d = vals(tok)
        light.append(f"  --{tok['name']}: {l};")
        dark.append(f"  --{tok['name']}: {d};")
    css = [f"/* Beayy 设计系统 — 由 设计系统/墨线/project/tokens.json 生成（app/ui/tools/同步墨线.py），不要手改 */",
           ":root {", *light, "  color-scheme: light;", "}",
           "@media (prefers-color-scheme: dark) {", '  :root:not([data-theme="light"]) {',
           *["  " + x for x in dark], "    color-scheme: dark;", "  }", "}",
           ':root[data-theme="dark"] {', *dark, "  color-scheme: dark;", "}", ""]
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "tokens.css").write_text("\n".join(css), encoding="utf-8")
    shutil.copyfile(SRC / "components/bundle.css", OUT / "bundle.css")
    ill = {}
    for m in re.finditer(r'<svg class="mx-illus" data-illus="([a-z]+)"(.*?)</svg>', (SRC / "components/Illustration/preview.html").read_text(encoding="utf-8"), re.S):
        ill[m.group(1)] = f'<svg class="mx-illus"{m.group(2)}</svg>'
    (OUT / "illus.js").write_text("// Beayy 设计系统的插画 — 由 设计系统/墨线/project/components/Illustration/preview.html 抽出（app/ui/tools/同步墨线.py），不要手改\n"
                                  f"window.MX_ILLUS = {json.dumps(ill, ensure_ascii=False, indent=1)};\n", encoding="utf-8")
    print(f"tokens.css {len(light)} 个变量（深色 {len(dark)} 个），bundle.css 已拷贝，插画 {len(ill)} 张 → {OUT}")


if __name__ == "__main__":
    main()
