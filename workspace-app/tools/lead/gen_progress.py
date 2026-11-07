import json, html, sys
d = json.load(open(sys.argv[1]))
e = html.escape
ST = {"gepland":"Gepland","bezig":"Bezig","critic":"Bij de criticus","gewonnen":"Wint van de lat","wacht":"Wacht op jou","geblokkeerd":"Geblokkeerd"}
rows = "".join(f'<tr class="s-{e(p["status"])}"><td class="id">{e(p["id"])}</td><td><b>{e(p["naam"])}</b><div class="sub">{e(p["stories"])}</div></td><td><span class="pill p-{e(p["status"])}">{e(ST.get(p["status"],p["status"]))}</span></td><td class="num">{p["ronde"] or "–"}</td><td class="gap">{e(p.get("gat") or p.get("oordeel") or "")}</td></tr>' for p in d["pieces"])
won = sum(1 for p in d["pieces"] if p["status"]=="gewonnen"); tot=len(d["pieces"])
human = "".join(f'<li><b>{e(h["wat"])}</b><div class="sub">{e(h.get("waarom",""))}</div></li>' for h in d["human"]) or '<li class="sub">Nog niets. Alles wat jouw handen of akkoord nodig heeft, komt hier in één lijst, zodat je in één keer test.</li>'
log = "".join(f"<li>{e(l)}</li>" for l in reversed(d["log"]))
out = f'''<title>Workspace bouwlog</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
/* Eén kolom: stand bovenaan, tabel met stukken, dan jouw testronde en het logboek. HomeZero-blauw en geel. */
:root {{ --bg:#fbfbf8; --panel:#fff; --ink:#292f38; --muted:#5d6573; --line:#e6e6e1; --blue:#0022c4; --blue-soft:#e7ebff; --yellow:#f9b20b; --yellow-soft:#fff4d6; --green:#1f7a4d; --green-soft:#e3f3ea; --red:#b42318; --red-soft:#fbe9e7; --font:"Inter",system-ui,sans-serif; --mono:"JetBrains Mono",ui-monospace,monospace; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --bg:#0f1430; --panel:#161c3d; --ink:#f2f3f7; --muted:#aab0c2; --line:#2a3157; --blue:#8ea2ff; --blue-soft:#1d2a6b; --yellow-soft:#3a3214; --green:#6fd19d; --green-soft:#133525; --red:#ff9a8f; --red-soft:#3b1d1a; color-scheme:dark; }} }}
:root[data-theme="dark"] {{ --bg:#0f1430; --panel:#161c3d; --ink:#f2f3f7; --muted:#aab0c2; --line:#2a3157; --blue:#8ea2ff; --blue-soft:#1d2a6b; --yellow-soft:#3a3214; --green:#6fd19d; --green-soft:#133525; --red:#ff9a8f; --red-soft:#3b1d1a; color-scheme:dark; }}
body {{ background:var(--bg); color:var(--ink); font-family:var(--font); font-size:15px; line-height:1.5; }}
.wrap {{ max-width:960px; margin:0 auto; padding-block:36px 64px; padding-left:max(16px, env(safe-area-inset-left,0px)); padding-right:max(16px, env(safe-area-inset-right,0px)); display:flex; flex-direction:column; gap:28px; }}
.eyebrow {{ font-size:12px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }}
h1 {{ font-size:clamp(28px,4.5vw,40px); letter-spacing:-.04em; margin:4px 0 0; font-weight:600; text-wrap:balance; }}
h2 {{ font-size:20px; letter-spacing:-.02em; margin:0 0 10px; font-weight:600; }}
.lead {{ color:var(--muted); max-width:68ch; margin:8px 0 0; }}
.bar {{ display:flex; gap:16px; flex-wrap:wrap; align-items:center; }}
.meter {{ flex:1 1 260px; height:10px; background:var(--line); border-radius:99px; overflow:hidden; }}
.meter i {{ display:block; height:100%; background:var(--blue); width:{round(100*won/tot)}%; }}
.num, .id {{ font-variant-numeric:tabular-nums; font-family:var(--mono); font-size:12.5px; }}
.card {{ background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:6px 0; overflow-x:auto; }}
table {{ border-collapse:collapse; width:100%; min-width:620px; }}
th, td {{ text-align:left; padding:10px 14px; border-top:1px solid var(--line); vertical-align:top; font-size:14px; }}
th {{ border-top:0; font-size:12px; color:var(--muted); font-weight:600; }}
.sub {{ color:var(--muted); font-size:13px; }}
.gap {{ color:var(--muted); font-size:13px; max-width:340px; }}
.pill {{ display:inline-block; font-size:12px; font-weight:600; border-radius:99px; padding:2px 9px; white-space:nowrap; background:var(--line); }}
.p-bezig, .p-critic {{ background:var(--blue-soft); color:var(--blue); }}
.p-gewonnen {{ background:var(--green-soft); color:var(--green); }}
.p-wacht {{ background:var(--yellow-soft); color:var(--ink); }}
.p-geblokkeerd {{ background:var(--red-soft); color:var(--red); }}
ul {{ margin:0; padding-left:18px; display:flex; flex-direction:column; gap:8px; }}
.human {{ background:var(--yellow-soft); border-radius:16px; padding:16px 18px; }}
.log li {{ font-size:13.5px; }}
</style>
<div class="wrap">
  <header><div class="eyebrow">HomeZero Workspace · bouw met builder en criticus · bijgewerkt {e(d["updated"])}</div>
    <h1>{e(d["status"])}</h1>
    <p class="lead">Elk stuk wordt gebouwd en daarna blind naast het artifact-prototype gelegd door een aparte, strenge criticus. Een stuk is pas af als de criticus het onze kiest en alle zelftests groen zijn.</p></header>
  <section class="bar"><div class="meter" role="img" aria-label="{won} van {tot} stukken winnen"><i></i></div><b class="num">{won}/{tot} winnen</b></section>
  <section><h2>Stukken</h2><div class="card"><table><thead><tr><th>Stuk</th><th>Wat</th><th>Stand</th><th>Ronde</th><th>Grootste gat volgens de criticus</th></tr></thead><tbody>{rows}</tbody></table></div></section>
  <section class="human"><h2>Jouw testronde</h2><ul>{human}</ul></section>
  <section class="log"><h2>Logboek</h2><ul>{log}</ul></section>
</div>'''
open(sys.argv[2],'w').write(out)
