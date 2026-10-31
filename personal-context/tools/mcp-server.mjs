#!/usr/bin/env node
// Minimale MCP-server (stdio, JSON-RPC 2.0, geen dependencies) boven de persoonlijke contextlaag.
// Lokaal koppelen in Claude Code:  claude mcp add context -- node /pad/naar/personal-context/tools/mcp-server.mjs
// In productie: dezelfde tools achter een webapp (HTTP/SSE) met GitHub als opslag, als custom connector in claude.ai.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, digest, parseFrontmatter } from './vault.mjs';

const ROOT = process.env.CONTEXT_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
let nodes = buildIndex(ROOT);
const reindex = () => { nodes = buildIndex(ROOT); };
const brief = n => ({ id: n.id, type: n.type, title: n.title, summary: n.summary });
const today = () => new Date().toISOString().slice(0, 10);
const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60);

function section(body, name) {
  const re = new RegExp(`^(#{1,3})\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi');
  const m = body.match(re); if (!m) return null;
  const start = m.index + m[0].length, level = m[1].length;
  const rest = body.slice(start); const next = rest.search(new RegExp(`^#{1,${level}}\\s`, 'm'));
  return rest.slice(0, next < 0 ? undefined : next).trim();
}

const TOOLS = {
  context_digest: {
    description: 'Overzicht van de contextlaag: één regel per notitie (id — summary). Begin hier; filter optioneel op type (partner, person, meeting, decision, week, roadmap, note) of map-prefix.',
    inputSchema: { type: 'object', properties: { type: { type: 'string' }, prefix: { type: 'string' } } },
    run: a => digest(nodes, a),
  },
  context_search: {
    description: 'Zoek op woorden in titel, summary, koppen en id. Geeft ids met summaries, geen volledige tekst.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, type: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
    run: ({ query, type, limit = 10 }) => {
      const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      return Object.values(nodes).filter(n => !type || n.type === type)
        .map(n => { const h = [n.id, n.title, n.summary, ...n.headings].join(' ').toLowerCase(); return [words.filter(w => h.includes(w)).length, n]; })
        .filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, n]) => brief(n));
    },
  },
  context_get: {
    description: 'Lees één notitie, of alleen één sectie (bijv. section "Open punten"). Gebruik section waar mogelijk om tokens te sparen.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, section: { type: 'string' } }, required: ['id'] },
    run: ({ id, section: sec }) => {
      const n = nodes[id]; if (!n) throw new Error(`Onbekende notitie: ${id}. Zoek eerst met context_search.`);
      const { data, body } = parseFrontmatter(readFileSync(join(ROOT, n.path), 'utf8'));
      return sec ? { id, section: sec, text: section(body, sec) ?? `(geen sectie "${sec}"; beschikbaar: ${n.headings.join(', ')})` } : { id, frontmatter: data, body };
    },
  },
  context_related: {
    description: 'Links en backlinks van een notitie, met summaries. Om te navigeren zonder te lezen.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: ({ id }) => {
      const n = nodes[id]; if (!n) throw new Error(`Onbekende notitie: ${id}`);
      const map = ids => ids.map(x => nodes[x] ? brief(nodes[x]) : { id: x, summary: x.startsWith('hz/') ? '(centrale laag)' : '(bestaat nog niet)' });
      return { node: brief(n), links: map(n.links), backlinks: map(n.backlinks) };
    },
  },
  context_route: {
    description: 'Stel voor waar de uitkomst van een meeting moet landen: partnernotitie, meetingnotitie, personen, besluiten, weeknotitie. Schrijft niets; gebruik daarna context_write.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, date: { type: 'string' }, partner: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' } }, decisions: { type: 'array', items: { type: 'string' } }, topic: { type: 'string', description: 'product of design-onderwerp, bijv. offerte-pdf' } }, required: ['title'] },
    run: ({ title, date = today(), partner, attendees = [], decisions = [], topic }) => {
      const pid = partner ? Object.values(nodes).find(n => n.type === 'partner' && (n.id.endsWith(slug(partner)) || n.title.toLowerCase().includes(String(partner).toLowerCase())))?.id || `partners/${slug(partner)}` : null;
      const mid = `meetings/${date.slice(0, 4)}/${date}-${slug(partner || title)}`;
      const people = attendees.map(a => Object.values(nodes).find(n => n.type === 'person' && n.title.toLowerCase().includes(String(a).toLowerCase()))?.id || `people/${slug(a)}`);
      const area = topic ? (nodes[`design/${slug(topic)}`] ? 'design' : nodes[`product/${slug(topic)}`] ? 'product' : 'product') : null;
      return {
        meeting: { id: mid, action: nodes[mid] ? 'append' : 'create', template: '_templates/meeting.md' },
        partner: pid && { id: pid, action: nodes[pid] ? 'append' : 'create', sections: ['Logboek', 'Open punten', 'Huidige stand'], central: `hz/${pid}` },
        people: people.map(id => ({ id, action: nodes[id] ? 'append' : 'create', section: 'Logboek' })),
        decisions: decisions.map(d => ({ id: `${area || 'product'}/decisions/${date}-${slug(d)}`, action: 'create', share: 'hz', topic: topic ? `${area}/${slug(topic)}` : null })),
        week: { id: `weeks/${isoWeek(date)}`, section: 'Check-ins' },
        commitments: 'Toezeggingen gaan naar de tracker in de Home Zero Workspace, niet naar markdown.',
      };
    },
  },
  context_write: {
    description: 'Maak een notitie aan of vul een sectie aan. Bij append wordt tekst onder de kop toegevoegd; updated wordt bijgewerkt. Voor nieuwe notities: geef frontmatter met type, title, summary.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, mode: { type: 'string', enum: ['create', 'append'] }, section: { type: 'string' }, text: { type: 'string' }, frontmatter: { type: 'object' } }, required: ['id', 'mode', 'text'] },
    run: ({ id, mode, section: sec, text, frontmatter = {} }) => {
      if (id.startsWith('hz/')) throw new Error('De centrale laag is alleen-lezen. Zet share: hz in een persoonlijke notitie; een routine maakt er een PR van.');
      const path = join(ROOT, id + '.md');
      if (mode === 'create' || !existsSync(path)) {
        const fm = { type: 'note', title: id.split('/').pop(), summary: '', ...frontmatter, id: id.split('/').pop(), updated: today() };
        const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n');
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `---\n${yaml}\n---\n${text.trim()}\n`);
      } else {
        let src = readFileSync(path, 'utf8').replace(/^updated: .*$/m, `updated: ${today()}`);
        if (sec) {
          const re = new RegExp(`^(#{1,3}\\s+${sec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*)$`, 'mi');
          if (re.test(src)) {
            const m = src.match(re); const at = m.index + m[0].length; const after = src.slice(at); const next = after.search(/^#{1,3}\s/m);
            const cut = next < 0 ? src.length : at + next;
            src = src.slice(0, cut).replace(/\s*$/, '\n') + text.trim() + '\n\n' + src.slice(cut);
          } else src = src.replace(/\s*$/, `\n\n## ${sec}\n${text.trim()}\n`);
        } else src = src.replace(/\s*$/, `\n\n${text.trim()}\n`);
        writeFileSync(path, src);
      }
      reindex();
      return { ok: true, id, node: nodes[id] ? brief(nodes[id]) : null };
    },
  },
};
function isoWeek(ds) { const d = new Date(ds + 'T12:00:00Z'); const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7))); const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 4)); return `${t.getUTCFullYear()}-W${String(1 + Math.round(((t - y) / 864e5 - 3 + ((y.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`; }

// JSON-RPC over stdio (één bericht per regel)
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let req; try { req = JSON.parse(line); } catch { continue; }
    const { id, method, params = {} } = req;
    if (method === 'initialize') send({ id, result: { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'robert-context', version: '0.1.0' } } });
    else if (method === 'tools/list') send({ id, result: { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) } });
    else if (method === 'tools/call') {
      const t = TOOLS[params.name];
      try { if (!t) throw new Error('Onbekende tool'); const out = t.run(params.arguments || {}); send({ id, result: { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] } }); }
      catch (e) { send({ id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } }); }
    } else if (id !== undefined) send({ id, result: {} });
  }
});
