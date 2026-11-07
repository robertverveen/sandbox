#!/usr/bin/env bash
# Zet de Workspace-app over van de sandbox-repo naar een eigen repo (OVERDRACHT.md, stap 2).
# Gebruik (vanuit de hoofdmap van de sandbox-repo, op de branch met de laatste stand):
#   workspace-app/tools/lead/naar-eigen-repo.sh <doelmap> [git-url-van-de-nieuwe-repo]
# Wat het doet:
#   1. haalt workspace-app/ met zijn geschiedenis los (git subtree split) naar een nieuwe map;
#   2. zet de CI-workflow in de hoofdmap en haalt de verwijzing naar workspace-app/ weg;
#   3. kopieert het prototype (de lat) en de architectuurplaat naar docs/prototype/;
#   4. vervangt de absolute cloudpaden in BRIEF.md en README door paden in de repo of omgevingsvariabelen;
#   5. commit, en pusht naar de nieuwe repo als je een URL meegeeft.
# Het wijzigt niets in de sandbox-repo behalve een tijdelijke branch export/workspace-app.
set -euo pipefail

SRC=$(git rev-parse --show-toplevel)
OUT=${1:?Geef een doelmap op, bijv. ../homezero-workspace}
URL=${2:-}
[ -e "$OUT" ] && { echo "Doelmap $OUT bestaat al; kies een nieuwe." >&2; exit 1; }
[ -n "$(git -C "$SRC" status --porcelain -- workspace-app workspace-prototype .github)" ] && { echo "Er staan niet-gecommitte wijzigingen in de sandbox; commit eerst." >&2; exit 1; }

echo "1/5 geschiedenis van workspace-app/ losmaken"
git -C "$SRC" branch -D export/workspace-app >/dev/null 2>&1 || true
git -C "$SRC" subtree split --prefix=workspace-app -b export/workspace-app >/dev/null
git init -q -b main "$OUT"
git -C "$OUT" pull -q "$SRC" export/workspace-app
git -C "$SRC" branch -D export/workspace-app >/dev/null

echo "2/5 CI-workflow naar de hoofdmap"
mkdir -p "$OUT/.github/workflows"
sed -e '/^defaults:/,/^$/d' \
    -e "s#paths: \['workspace-app/\*\*', '.github/workflows/workspace-app.yml'\]#paths-ignore: ['docs/**', '*.md']#" \
    -e 's#workspace-app/package.json#package.json#; s#workspace-app/pnpm-lock.yaml#pnpm-lock.yaml#' \
    -e 's#^name: workspace-app#name: ci#' \
    -e 's#^\# CI van de HomeZero Workspace-app (HZW-001).*#\# CI van de HomeZero Workspace (HZW-001).#' \
    "$SRC/.github/workflows/workspace-app.yml" > "$OUT/.github/workflows/ci.yml"
grep -q 'workspace-app/' "$OUT/.github/workflows/ci.yml" && { echo "Let op: ci.yml noemt nog workspace-app/; controleer het bestand." >&2; }

echo "3/5 prototype en plaat naar docs/prototype/"
mkdir -p "$OUT/docs/prototype"
cp "$SRC/workspace-prototype/index.html" "$SRC/workspace-prototype/architectuur.html" "$SRC/workspace-prototype/README.md" "$OUT/docs/prototype/"
[ -d "$SRC/workspace-prototype/tools" ] && cp -r "$SRC/workspace-prototype/tools" "$OUT/docs/prototype/"
sed -i.bak "s#resolve(root, '../workspace-prototype/index.html')#resolve(root, 'docs/prototype/index.html')#; s#standaard ../workspace-prototype/index.html naast deze repo#standaard docs/prototype/index.html#" "$OUT/tools/bar/bar.mjs" && rm -f "$OUT/tools/bar/bar.mjs.bak"

echo "4/5 paden in BRIEF.md, README.md en HUMAN_INPUT.md"
for f in BRIEF.md README.md HUMAN_INPUT.md; do
  [ -f "$OUT/$f" ] || continue
  sed -i.bak \
    -e 's#/home/user/sandbox/workspace-prototype/#docs/prototype/#g' \
    -e 's#/home/user/sandbox/workspace-app/#./#g; s#/home/user/sandbox/workspace-app#.#g' \
    -e 's#/home/user/homezero-context#$HZ_CONTEXT_REPO#g; s#/home/user/context-prive#$HZ_PERSOONLIJK_REPO#g' \
    -e 's#`/tmp/claude-0/[^`]*ctx-export/`#een export die je zelf maakt met `pnpm --filter @hz/context export` (in .local/, nooit in Git)#g' \
    -e 's#`/tmp/claude-0/[^`]*test1[67]\.js`#`tools/bar/bar.mjs`#g' \
    -e 's#workspace-app/##g' \
    "$OUT/$f" && rm -f "$OUT/$f.bak"
done
if grep -n '/home/user\|/tmp/claude' "$OUT"/BRIEF.md "$OUT"/README.md "$OUT"/HUMAN_INPUT.md; then
  echo "Let op: hierboven staan nog absolute cloudpaden; pas ze met de hand aan." >&2
fi

echo "5/5 commit"
git -C "$OUT" add -A
git -C "$OUT" commit -q -m "Overdracht uit de sandbox: CI in de hoofdmap, prototype in docs/prototype, paden in de repo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LLbbsA3zLQrYcfMbA29s88"
if [ -n "$URL" ]; then
  git -C "$OUT" remote add origin "$URL"
  git -C "$OUT" push -u origin main
fi
echo "Klaar: $OUT ($(git -C "$OUT" rev-list --count HEAD) commits)."
