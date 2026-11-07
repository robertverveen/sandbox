/**
 * Kleine Caddyfile-parser voor de tests (HZW-003): woorden, "strings", commentaar en blokken. Genoeg om de
 * structuur te controleren (sites, directives, geneste blokken); de echte controle doet `caddy validate` in
 * infra/scripts/validate.sh en in de workflow workspace-infra.
 */
export interface Node {
  tokens: string[];
  line: number;
  children?: Node[];
}

interface Tok {
  t: string;
  line: number;
  nl: boolean;
}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  let cur = '';
  let curLine = 1;
  const push = () => {
    if (cur) out.push({ t: cur, line: curLine, nl: false });
    cur = '';
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\n') {
      push();
      out.push({ t: '\n', line, nl: true });
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      push();
      i++;
      continue;
    }
    if (c === '#' && cur === '') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"' && cur === '') {
      curLine = line;
      i++;
      let s = '';
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          s += src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === '\n') line++;
        s += src[i++];
      }
      if (src[i] !== '"') throw new Error(`regel ${curLine}: string niet afgesloten`);
      i++;
      out.push({ t: s, line: curLine, nl: false });
      continue;
    }
    if (!cur) curLine = line;
    cur += c;
    i++;
  }
  push();
  return out;
}

export function parseCaddyfile(src: string): Node[] {
  const toks = lex(src);
  let pos = 0;
  function block(depth: number): Node[] {
    const nodes: Node[] = [];
    let tokens: string[] = [];
    let line = 0;
    while (pos < toks.length) {
      const k = toks[pos++]!;
      if (k.nl) {
        if (tokens.length) nodes.push({ tokens, line });
        tokens = [];
        continue;
      }
      if (k.t === '}') {
        if (tokens.length) throw new Error(`regel ${k.line}: '}' moet op een eigen regel`);
        if (depth === 0) throw new Error(`regel ${k.line}: '}' zonder '{'`);
        return nodes;
      }
      if (k.t === '{') {
        const next = toks[pos];
        if (next && !next.nl) throw new Error(`regel ${k.line}: na '{' hoort een nieuwe regel`);
        const children = block(depth + 1);
        nodes.push({ tokens, line: line || k.line, children });
        tokens = [];
        continue;
      }
      if (!tokens.length) line = k.line;
      tokens.push(k.t);
    }
    if (depth > 0) throw new Error("ontbrekende '}'");
    if (tokens.length) nodes.push({ tokens, line });
    return nodes;
  }
  return block(0);
}

/** Alle nodes (diep) waarvan het eerste token gelijk is aan name. */
export function findAll(nodes: Node[], name: string): Node[] {
  const out: Node[] = [];
  for (const n of nodes) {
    if (n.tokens[0] === name) out.push(n);
    if (n.children) out.push(...findAll(n.children, name));
  }
  return out;
}

export function site(nodes: Node[], address: string): Node {
  const s = nodes.find((n) => n.children && n.tokens.length === 1 && n.tokens[0] === address);
  if (!s) throw new Error(`site ${address} niet gevonden`);
  return s;
}
