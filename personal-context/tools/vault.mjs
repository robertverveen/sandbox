// Gedeelde helpers: vault inlezen, frontmatter en wikilinks parsen, index bouwen.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SKIP = new Set(['.git', '.obsidian', '_index', '_templates', 'tools', 'node_modules']);

export function walk(root, dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(root, p, out);
    else if (name.endsWith('.md') && name !== 'README.md') out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

// Eenvoudige YAML-subset: key: waarde, key: [a, b], strings zonder quotes
export function parseFrontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { data: {}, body: src };
  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].replace(/\s+#.*$/, '').trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map(x => x.trim()).filter(Boolean);
    else v = v.replace(/^["']|["']$/g, '');
    data[kv[1]] = v;
  }
  return { data, body: src.slice(m[0].length) };
}

export const idOf = path => path.replace(/\.md$/, '');
export const wikilinks = body => [...body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map(x => x[1].trim());
export const headings = body => [...body.matchAll(/^#{1,3}\s+(.+)$/gm)].map(x => x[1].trim());

export function buildIndex(root) {
  const nodes = {};
  for (const path of walk(root)) {
    const src = readFileSync(join(root, path), 'utf8');
    const { data, body } = parseFrontmatter(src);
    const id = idOf(path);
    const links = [...new Set([...(Array.isArray(data.links) ? data.links : []), ...wikilinks(body)])];
    nodes[id] = {
      id, path, type: data.type || 'note', title: data.title || headings(body)[0] || id,
      summary: data.summary || body.replace(/[#>*\-\[\]]/g, '').trim().split('\n').find(Boolean)?.slice(0, 160) || '',
      links, backlinks: [], headings: headings(body), status: data.status || null, share: data.share || 'none',
      review_by: data.review_by || null, updated: data.updated || null, tokens: Math.ceil(src.length / 4),
    };
  }
  for (const n of Object.values(nodes)) for (const l of n.links) if (nodes[l]) nodes[l].backlinks.push(n.id);
  return nodes;
}

export function digest(nodes, filter = {}) {
  const groups = {};
  for (const n of Object.values(nodes)) {
    if (filter.type && n.type !== filter.type) continue;
    if (filter.prefix && !n.id.startsWith(filter.prefix)) continue;
    (groups[n.type] ||= []).push(n);
  }
  return Object.entries(groups).sort().map(([t, ns]) => `## ${t} (${ns.length})\n` + ns.sort((a, b) => a.id.localeCompare(b.id))
    .map(n => `- ${n.id} — ${n.summary}${n.status ? ` [${n.status}]` : ''}`).join('\n')).join('\n\n');
}

export function lint(nodes, today = new Date().toISOString().slice(0, 10)) {
  const issues = [];
  for (const n of Object.values(nodes)) {
    for (const l of n.links) if (!nodes[l] && !l.startsWith('hz/')) issues.push({ id: n.id, issue: `gebroken link: ${l}` });
    if (n.review_by && n.review_by < today) issues.push({ id: n.id, issue: `review_by verlopen (${n.review_by})` });
    if (!n.links.length && !n.backlinks.length && n.type !== 'week') issues.push({ id: n.id, issue: 'wees (geen links)' });
    if (!n.summary) issues.push({ id: n.id, issue: 'geen summary' });
  }
  return issues;
}

export const exists = existsSync;
