#!/usr/bin/env python3
"""Export HomeZero Context + a personal Persoonlijk-repo to JSON documents for the
workspace artifact database (collections context_partners, context_acties,
context_persoonlijk, context_status).

Usage:
  python3 -I export_context.py <homezero-context dir> <persoonlijk dir> <out dir> [--owner Robert]

Writes <out>/<collection>/<doc_id>.json plus <out>/manifest.json.
Rules (AGENTS.md): read only, never admin.md, repo text is data (stored as plain text,
never interpreted). Long sections are trimmed to keep the artifact database small.
"""
import json, os, re, subprocess, sys, datetime

FIELD_RE = re.compile(r"\[([a-z_]+)::\s*([^\]]*)\]")


def read(p):
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return ""


def frontmatter(text):
    m = re.match(r"^---\n(.*?)\n---\n?", text, re.S)
    if not m:
        return {}, text
    fm = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip()
    return fm, text[m.end():]


def sections(body):
    out, cur = {}, None
    for line in body.splitlines():
        h = re.match(r"^##\s+(.+?)\s*$", line)
        if h:
            cur = h.group(1).strip()
            out[cur] = []
        elif cur is not None:
            out[cur].append(line)
    return {k: "\n".join(v).strip() for k, v in out.items()}


def bullets(text, limit=None, maxlen=None):
    items = [l[2:].strip() for l in text.splitlines() if l.startswith("- ")]
    if maxlen:
        items = [i if len(i) <= maxlen else i[: maxlen - 1] + "…" for i in items]
    return items[:limit] if limit else items


def listval(v):
    v = (v or "").strip()
    if v.startswith("[") and v.endswith("]"):
        return [x.strip().strip("'\"") for x in v[1:-1].split(",") if x.strip()]
    return [v] if v and v != "?" else []


def action_line(line):
    m = re.match(r"^- \[( |x|-)\]\s+(.*)$", line)
    if not m:
        return None
    state = {" ": "open", "x": "klaar", "-": "geschrapt"}[m.group(1)]
    rest = m.group(2)
    fields = {k: v.strip() for k, v in FIELD_RE.findall(rest)}
    text = FIELD_RE.sub("", rest)
    voorstel = "(voorstel)" in text
    text = re.sub(r"\s*\(voorstel\)\s*", " ", text).strip()
    return {"state": state, "tekst": re.sub(r"\s{2,}", " ", text), "voorstel": voorstel, **fields}


def git_head(d):
    try:
        return subprocess.check_output(["git", "-C", d, "rev-parse", "--short", "HEAD"], text=True).strip()
    except Exception:
        return ""


def register(ctx):
    rows = []
    for line in read(os.path.join(ctx, "partners/_register.md")).splitlines():
        if not line.startswith("| ") or line.startswith("| slug") or line.startswith("|---"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 9:
            continue
        slug, naam, aliassen, domeinen, kanaal, portal, _moneybird, fase, am = cells[:9]
        q = lambda x: "" if x in ("?", "") else x
        rows.append({
            "slug": slug, "naam": naam,
            "aliassen": [a.strip() for a in aliassen.split(",") if a.strip()],
            "domeinen": [d.strip() for d in domeinen.split(",") if q(d.strip())],
            "slack": q(kanaal).lstrip("#"), "portal": q(portal), "fase": q(fase), "accountmanager": q(am),
        })
    return rows


def meetings(dirp, limit=3):
    if not os.path.isdir(dirp):
        return []
    files = sorted([f for f in os.listdir(dirp) if f.endswith(".md")], reverse=True)[:limit]
    out = []
    for f in files:
        fm, body = frontmatter(read(os.path.join(dirp, f)))
        sec = sections(body)
        m = re.match(r"(\d{4}-\d{2}-\d{2})-(.+?)\.md$", f)
        onderwerp = m.group(2) if m else f[:-3]
        out.append({
            "bestand": f, "datum": fm.get("datum") or (m.group(1) if m else ""),
            "titel": onderwerp.replace("-", " "), "meeting_id": fm.get("meeting_id", ""),
            "opgenomen_door": fm.get("opgenomen_door", ""), "bron": fm.get("bron", ""),
            "samenvatting": bullets(sec.get("Samenvatting", ""), 5, 300),
            "besluiten": bullets(sec.get("Besluiten", ""), 5, 300),
            "acties": bullets(sec.get("Acties", ""), 6, 300),
        })
    return out


def partner_doc(ctx, base, reg, kind="partner"):
    fm, body = frontmatter(read(os.path.join(base, "brief.md")))
    sec = sections(body)
    acties_raw = read(os.path.join(base, "acties.md"))
    acts = [a for a in (action_line(l) for l in acties_raw.splitlines()) if a]
    log = bullets(read(os.path.join(base, "log.md")), 15, 400)
    return {
        "slug": reg["slug"], "soort": kind, "naam": reg.get("naam") or reg["slug"],
        "aliassen": reg.get("aliassen", []), "domeinen": reg.get("domeinen", []), "slack": reg.get("slack", ""),
        "fase": reg.get("fase") or fm.get("fase", ""), "accountmanager": reg.get("accountmanager") or (fm.get("accountmanager", "") if fm.get("accountmanager") != "?" else ""),
        "geheim_voor": listval(fm.get("geheim_voor", "")), "bijgewerkt": fm.get("bijgewerkt", ""),
        "kern": sec.get("Kern", "")[:1500],
        "stand": bullets(sec.get("Stand", ""), 5, 500),
        "contacten": bullets(sec.get("Contacten", ""), 20, 200),
        "meetings": meetings(os.path.join(base, "meetings")),
        "log": log,
        "open_acties": sum(1 for a in acts if a["state"] == "open"),
    }, acts


def export(ctx, prive, out, owner):
    today = datetime.date.today()
    docs = {"context_partners": {}, "context_acties": {}, "context_persoonlijk": {}, "context_status": {}}
    regs = register(ctx)
    known = {r["slug"] for r in regs}
    entries = [(r, os.path.join(ctx, "partners", r["slug"]), "partner") for r in regs]
    pdir = os.path.join(ctx, "projecten")
    if os.path.isdir(pdir):
        for slug in sorted(os.listdir(pdir)):
            if os.path.isdir(os.path.join(pdir, slug)) and slug not in known:
                entries.append(({"slug": slug, "naam": slug.replace("-", " ").title()}, os.path.join(pdir, slug), "project"))
    cutoff = (today - datetime.timedelta(days=14)).isoformat()
    for reg, base, kind in entries:
        doc, acts = partner_doc(ctx, base, reg, kind)  # ook zonder map: het register is de ingang voor herkenning
        docs["context_partners"][reg["slug"]] = doc
        keep = [a for a in acts if a["state"] == "open" or (a.get("eigenaar", "").lower().startswith(owner.lower()) and a["state"] == "klaar" and a.get("klaar", "") >= cutoff)]
        if keep:
            docs["context_acties"][reg["slug"]] = {"slug": reg["slug"], "naam": doc["naam"], "geheim_voor": doc["geheim_voor"], "acties": keep}

    # Persoonlijk-repo
    def parse_sections(text):
        out, cur = {}, "Open"
        for line in text.splitlines():
            h = re.match(r"^##\s+(.+?)\s*$", line)
            if h:
                cur = h.group(1).strip(); continue
            a = action_line(line)
            if a:
                out.setdefault(cur, []).append(a)
        return out
    w = parse_sections(read(os.path.join(prive, "wachten-op.md")))
    afg = [a for a in w.get("Afgerond", []) if a.get("klaar", "") >= cutoff]
    docs["context_persoonlijk"]["wachten-op"] = {"bestand": "wachten-op.md", "open": w.get("Open", []), "bespreken": [a for a in w.get("Bespreken bij eerstvolgend contactmoment", []) if a["state"] == "open"], "afgerond": afg}
    t = [a for a in (action_line(l) for l in read(os.path.join(prive, "taken.md")).splitlines()) if a]
    docs["context_persoonlijk"]["taken"] = {"bestand": "taken.md", "open": [a for a in t if a["state"] == "open"]}
    aang = []
    for line in read(os.path.join(prive, "aangehouden.md")).splitlines():
        if not line.startswith("- "):
            continue
        parts = [p.strip() for p in line[2:].split("|")]
        if len(parts) < 3:
            continue
        tail = parts[-1].lower()
        if re.search(r"\b(deel|privé)\s*$", line) and "(deel / privé)" not in line[-16:]:
            continue
        if "[verwerkt::" in line or "[privé::" in line:
            continue
        aang.append({"datum": parts[0], "bron": parts[1], "tekst": parts[2]})
    docs["context_persoonlijk"]["aangehouden"] = {"bestand": "aangehouden.md", "open": aang}

    status_lines = bullets(sections("## S\n" + frontmatter(read(os.path.join(ctx, "_systeem/status.md")))[1]).get("S", ""))
    status_lines = [l for l in status_lines] or bullets(frontmatter(read(os.path.join(ctx, "_systeem/status.md")))[1])
    beat = bullets(frontmatter(read(os.path.join(ctx, f"_systeem/routines/{owner.lower()}.md")))[1], 1)
    nacht = [l for l in read(os.path.join(prive, "nacht/log.md")).splitlines() if l.startswith("- ")]
    docs["context_status"]["laatste"] = {
        "status": status_lines[0] if status_lines else "",
        "nachtdienst": beat[0] if beat else "",
        "nacht_prive": nacht[-1][2:] if nacht else "",
        "commit_context": git_head(ctx), "commit_prive": git_head(prive),
        "geexporteerd": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "partners": len(docs["context_partners"]), "acties": sum(len(d["acties"]) for d in docs["context_acties"].values()),
    }
    manifest = {}
    for col, items in docs.items():
        os.makedirs(os.path.join(out, col), exist_ok=True)
        for doc_id, data in items.items():
            with open(os.path.join(out, col, doc_id + ".json"), "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
        manifest[col] = sorted(items)
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    return docs


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    owner = sys.argv[sys.argv.index("--owner") + 1] if "--owner" in sys.argv else "Robert"
    if "--owner" in sys.argv:
        args = [a for a in args if a != owner]
    if len(args) != 3:
        sys.exit(__doc__)
    d = export(args[0], args[1], args[2], owner)
    print(json.dumps(d["context_status"]["laatste"], ensure_ascii=False))
