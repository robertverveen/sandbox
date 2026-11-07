export const meta = {
  name: 'workspace-golf',
  description: 'Bouw een golf stukken van de Workspace-webapp: per stuk builder en strenge criticus in een eigen worktree tot het onze wint, daarna samenvoegen',
  phases: [{ title: 'Bouwen' }, { title: 'Criticus' }, { title: 'Samenvoegen' }],
}

const BASE = args.base
// Paden: standaard de cloud-sandbox; lokaal of in de eigen repo geef je args.paths mee (zie OVERDRACHT.md).
const P = args.paths || {}
const REPO = P.repo || '/home/user/sandbox'
const SUB = P.appSub ?? 'workspace-app'
const APP = SUB ? `${REPO}/${SUB}` : REPO
const PLATE = P.plate || '/home/user/sandbox/workspace-prototype/architectuur.html'
const PROTO = P.proto || '/home/user/sandbox/workspace-prototype/index.html'
const WTROOT = P.wtRoot || '/home/user/wt'
const CTX = P.ctxRepo || '/home/user/homezero-context'
const PERS = P.persRepo || '/home/user/context-prive'
const MAX = args.maxRounds || 6

const PIECE_SUMMARY = {
  type: 'object',
  properties: {
    stories_done: { type: 'array', items: { type: 'string' } },
    stories_open: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    human_input: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['stories_done', 'stories_open', 'tests', 'human_input', 'notes'],
}
const VERDICT = {
  type: 'object',
  properties: {
    winner: { type: 'string', enum: ['ours', 'bar'] },
    tests_green: { type: 'boolean' },
    stories_really_done: { type: 'array', items: { type: 'string' } },
    biggest_gap: { type: 'string' },
    fixes: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'string' },
  },
  required: ['winner', 'tests_green', 'stories_really_done', 'biggest_gap', 'fixes', 'evidence'],
}

const wt = p => `${WTROOT}/${p.id}`
const inWt = p => (SUB ? `${wt(p)}/${SUB}` : wt(p))

function builderPrompt(p, round, prev) {
  return `Je bent de BUILDER voor stuk ${p.id} (${p.name}) van de HomeZero Workspace-webapp. Ronde ${round}.

Lees eerst helemaal: ${APP}/BRIEF.md (je enige context, alle regels gelden), ${APP}/README.md, ${APP}/HUMAN_INPUT.md, en in ${APP}/stories.json jouw stories: ${p.stories}. De besloten keuzes staan in ${PLATE} (uitklapbare keuzes 01-14, 10 Tracker, 12a Skills, kritische noten). Het fundament (monorepo, contract, RLS, providers, schil, Dagstart) staat al en is goedgekeurd: bouw daarop voort, breek het niet.

Werkplek: een eigen git-worktree ${wt(p)} op branch ws/${p.id}. Bestaat die nog niet: \`git -C ${REPO} worktree add ${wt(p)} -b ws/${p.id} ${BASE}\`. Bestaat hij al (vorige ronde): ga daar verder. De app staat in ${inWt(p)}. Daar \`pnpm install\` (pnpm-store is gedeeld, dus snel). Werk NOOIT in ${REPO} zelf en niet in andermans worktree.
Eigen middelen om botsingen met parallelle stukken te voorkomen: database-namen beginnen met hz_${p.id.toLowerCase()} (ook testdatabases), API-poort ${p.port}, web-poort ${p.port + 100}, e2e via HZ_E2E_API_PORT=${p.port + 50} HZ_E2E_WEB_PORT=${p.port + 150}. Postgres 16 op localhost:5432, rol hz_dev/hz_dev.

Wat dit stuk moet opleveren:
${p.notes}

Samenvoegen komt later: andere stukken bouwen tegelijk. Houd daarom wijzigingen aan gedeelde bestanden klein en toevoegend. Nieuwe database-migraties: aparte SQL-bestanden met een naam die met ${p.id.toLowerCase()} begint na het volgnummer, en werk drizzle/meta/_journal.json bij; de samenvoeger nummert zo nodig om. Nieuwe routes in het contract (packages/shared) toevoegen, bestaande niet hernoemen.

${round > 1 ? `De strenge criticus wees het vorige ronde af. Grootste gat: ${prev.biggest_gap}
Fixes die hij eist (allemaal doen, grootste gat eerst):
${prev.fixes.map(f => '- ' + f).join('\n')}
Zijn bewijs: ${prev.evidence.slice(0, 3000)}
` : ''}
Definition of done: elke story van dit stuk heeft een geautomatiseerde zelftest die de zelftest uit stories.json echt dekt (geen .skip, geen nep-asserts); \`pnpm -r typecheck\`, \`pnpm -r test\`, \`pnpm lint\` en, als je UI raakt, \`pnpm test:e2e\` zijn groen in je worktree. Waar een scherm bestaat in het prototype: minstens zo goed als de lat (zelfde huisstijl, toetsen, licht en donker, 400px zonder horizontale scroll, axe zonder ernstige fouten) en maak met tools/shot en tools/bar zelf de vergelijking voordat je klaar meldt.
Alles wat een mens moet doen (accounts, OAuth-apps, secrets, DNS, server, goedkeuringen uit stories.json) blokkeert je niet: bouw tot waar het kan en zet het als rij in HUMAN_INPUT.md van je worktree (story, wat, hoe testen, nodig). Vermijd dubbele rijen.
Harde regels: geen echte partnerdata, contacten of mails in Git (fixtures synthetisch of uit de demodata van het prototype); geen secrets in Git; geen netwerkcalls naar echte Google/Slack/Jira/Anthropic in tests (officiële API-documentatie online lezen mag); nooit schrijven in ${CTX} of ${PERS} (tests op tijdelijke kopieën); de app verstuurt nooit zelf iets.
Commit regelmatig op ws/${p.id}, berichten in het Nederlands, elk bericht eindigt met:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LLbbsA3zLQrYcfMbA29s88
Niet pushen. Eindig met een schone worktree (alles gecommit) en geef de samenvatting terug.`
}

function criticPrompt(p, round, built) {
  return `Je bent de STRENGE CRITICUS voor stuk ${p.id} (${p.name}) van de HomeZero Workspace-webapp, ronde ${round}. Je hebt frisse context. Lof heeft geen zin; je taak is binair.

Lees ${APP}/BRIEF.md (vooral het criticus-protocol) en in ${APP}/stories.json de stories ${p.stories}, plus de relevante keuzes in ${PLATE}.
Het werk staat in de worktree ${wt(p)} (branch ws/${p.id}), app in ${inWt(p)}. Je mag daar commando's draaien maar geen broncode wijzigen; ruim eigen proefdata op. Gebruik databases met prefix hz_${p.id.toLowerCase()}_critic en poorten ${p.port + 200}-${p.port + 260}.

Wat dit stuk moet opleveren:
${p.notes}

De builder meldt (vertrouw dit niet, controleer het): ${JSON.stringify(built || {}).slice(0, 2500)}

Doe zelf:
1. \`pnpm install\`, \`pnpm -r typecheck\`, \`pnpm -r test\`, \`pnpm lint\`, en \`pnpm test:e2e\` met HZ_E2E_API_PORT=${p.port + 210} HZ_E2E_WEB_PORT=${p.port + 211}. Start de app en probeer de functies van dit stuk echt uit.
2. Per story: is hij echt af volgens de zelftest in stories.json, of is er alleen code? Lees de tests: dekken ze het gedrag of zijn het lege asserts?
3. De lat: het artifact-prototype ${PROTO} (laad met tools/bar of het harnas uit BRIEF.md). Heeft dit stuk schermen of gedrag dat het prototype ook heeft, leg ze blind naast elkaar (zelfde data en viewport 1440x1000 en 400x860, licht en donker, labels weg, willekeurige volgorde X/Y, oordeel vóór je de sleutel bekijkt). Voor infrastructuur of backend zonder scherm: de lat is wat het prototype in die functie kan plus de keuzes van de plaat; het onze wint alleen als het dat echt, veilig en getest doet.
4. Veiligheid: geen echte partnerdata, contacten, mails of secrets in de diff (\`git -C ${wt(p)} diff ${BASE}...ws/${p.id}\`); RLS niet verzwakt; geen netwerkcalls naar echte diensten in tests; niets dat zelf verstuurt.
5. Wat een mens moet doen hoort in HUMAN_INPUT.md met een duidelijke testinstructie; dat telt niet als gat.
Oordeel: winner "ours" alleen als het onze blind wint (of bij backend: de lat aantoonbaar overtreft) ÉN alle tests groen zijn ÉN elke story van het stuk echt af is (op human input na). Anders "bar". Geef het grootste gat in één zin en concrete fixes met bestand en wat.`
}

async function runPiece(p) {
  let prev = null, built = null, verdict = null
  for (let round = 1; round <= MAX; round++) {
    built = await agent(builderPrompt(p, round, prev), { label: `bouw ${p.id} r${round}`, phase: 'Bouwen', schema: PIECE_SUMMARY })
    verdict = await agent(criticPrompt(p, round, built), { label: `criticus ${p.id} r${round}`, phase: 'Criticus', schema: VERDICT })
    if (!verdict) { log(`${p.id}: criticus gaf geen oordeel in ronde ${round}`); continue }
    log(`${p.id} ronde ${round}: ${verdict.winner}, tests ${verdict.tests_green ? 'groen' : 'rood'}; gat: ${verdict.biggest_gap.slice(0, 160)}`)
    if (verdict.winner === 'ours' && verdict.tests_green) return { id: p.id, won: true, rounds: round, built, verdict }
    prev = verdict
  }
  log(`${p.id}: na ${MAX} rondes nog niet gewonnen`)
  return { id: p.id, won: false, rounds: MAX, built, verdict }
}

phase('Bouwen')
const results = (await pipeline(args.pieces, p => runPiece(p))).filter(Boolean)

phase('Samenvoegen')
const winners = results.filter(r => r.won).map(r => r.id)
let merge = null
if (winners.length) {
  merge = await agent(`Je bent de SAMENVOEGER van golf ${args.wave} van de HomeZero Workspace-webapp. Lees ${APP}/BRIEF.md en ${APP}/README.md.
Werk in ${REPO} op branch ${BASE} (controleer met git status dat hij schoon is). Voeg één voor één samen met \`git merge --no-ff ws/<id>\`: ${winners.map(w => 'ws/' + w).join(', ')}.
Conflicten: behoud het werk van beide kanten. Drizzle-migraties: maak de volgnummers en drizzle/meta/_journal.json consistent (geen dubbele nummers, volgorde zodat elke migratie op de vorige past). HUMAN_INPUT.md: alle rijen samen, ontdubbeld, op story-volgorde. Contract en routes: beide behouden.
Daarna in ${APP}: \`pnpm install\`, \`pnpm -r typecheck\`, \`pnpm -r test\`, \`pnpm lint\`, \`pnpm build\`, \`pnpm test:e2e\` (HZ_E2E_API_PORT=8790 HZ_E2E_WEB_PORT=8791), en de migraties op een verse database hz_merge_${args.wave.toLowerCase()}. Repareer integratiefouten tot alles groen is, zonder tests over te slaan of te verzwakken.
Controleer dat de samengevoegde diff geen echte partnerdata, contacten, mails of secrets bevat.
Commit (berichten eindigen met de twee regels Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com> en Claude-Session: https://claude.ai/code/session_01LLbbsA3zLQrYcfMbA29s88). Niet pushen. Verwijder daarna de worktrees van de samengevoegde stukken met \`git worktree remove\` (branches laten staan).
Geef terug: wat samengevoegd is, welke conflicten je oploste, testuitslag per commando, en de volledige lijst rijen in HUMAN_INPUT.md.`, { label: 'samenvoegen', phase: 'Samenvoegen' })
}

return {
  pieces: results.map(r => ({ id: r.id, won: r.won, rounds: r.rounds, biggest_gap: r.verdict?.biggest_gap, tests_green: r.verdict?.tests_green, stories_really_done: r.verdict?.stories_really_done, human_input: r.built?.human_input, fixes_open: r.won ? [] : r.verdict?.fixes })),
  merge,
}
