#!/usr/bin/env python3
"""Generate docs/reference/settings/*.md from `rPDU2MQTT --emit-schema` output.

Usage: dotnet rPDU2MQTT.dll --emit-schema > schema.json && python3 generate-settings.py schema.json
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "docs", "reference", "settings")


def cell(text):
    return str(text).replace("|", "\\|").replace("\n", " ").strip()


def fmt_default(v):
    if isinstance(v, bool):
        return "`true`" if v else "`false`"
    if v is None or v == "":
        return ""
    if isinstance(v, (list, dict)):
        return "`" + json.dumps(v) + "`" if v else ""
    return f"`{v}`"


def fmt_type(n):
    t = n.get("type", "")
    if t == "enum":
        vals = [v for v in n.get("enumValues", []) if v != ""]
        return "one of " + ", ".join(f"`{v}`" for v in vals)
    if t == "password":
        return "string (secret)"
    if t == "dictionary":
        return "map"
    return t


def notes(n):
    parts = []
    if n.get("description"):
        parts.append(n["description"])
    if "min" in n or "max" in n:
        parts.append(f"Range {n.get('min', '')}–{n.get('max', '')}.")
    if n.get("templateVars") and "Placeholders" not in n.get("description", ""):
        parts.append("Placeholders: " + ", ".join("`{" + v + "}`" for v in n["templateVars"]) + ".")
    return " ".join(parts)


def rows(n, path, out):
    kids = n.get("properties")
    t = n.get("type")
    if path:
        out.append(f"| `{path}` | {cell(fmt_type(n))} | {fmt_default(n.get('default'))} | {cell(notes(n))} |")
    if t == "object" and kids:
        for c in kids:
            rows(c, f"{path}.{c['key']}" if path else c["key"], out)
    elif t == "list" and n.get("valueSchema"):
        for c in n["valueSchema"].get("properties") or []:
            rows(c, f"{path}[].{c['key']}", out)
    elif t == "dictionary" and n.get("valueSchema"):
        for c in n["valueSchema"].get("properties") or []:
            rows(c, f"{path}.<name>.{c['key']}", out)


def main(schema_path):
    with open(schema_path, encoding="utf-8") as f:
        schema = json.load(f)
    os.makedirs(OUT, exist_ok=True)
    index = []
    for sec in schema:
        key = sec["key"]
        slug = key.lower()
        out = []
        rows(sec, key, out)
        body = [
            "---",
            f"title: {sec.get('label') or key}",
            "---",
            "",
            f"# {sec.get('label') or key}",
            "",
            "Generated from `rPDU2MQTT --emit-schema`. Keys are case-insensitive. "
            "`[]` marks a list item and `<name>` a map key of your choosing. "
            "A blank default means none is declared.",
            "",
        ]
        if sec.get("description"):
            body += [sec["description"], ""]
        body += ["| Setting | Type | Default | Description |", "| --- | --- | --- | --- |"]
        body += out
        with open(os.path.join(OUT, f"{slug}.md"), "w", encoding="utf-8") as f:
            f.write("\n".join(body) + "\n")
        index.append((sec.get("label") or key, slug, len(out)))
    lines = ["---", "title: Settings reference", "---", "", "# Settings reference", "",
             "Every setting in `config.yaml`, one page per top-level section, generated from "
             "`rPDU2MQTT --emit-schema`.", "", "| Section | Settings |", "| --- | --- |"]
    lines += [f"| [{label}]({slug}.md) | {count} |" for label, slug, count in index]
    with open(os.path.join(OUT, "index.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "schema.json")
