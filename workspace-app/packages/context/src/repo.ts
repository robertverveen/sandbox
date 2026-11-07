/**
 * Alleen-lezen toegang tot een repo op schijf. Eén plek die bestanden opent, zodat de regels
 * hard zijn: nooit `admin.md` (AGENTS.md), nooit buiten de repo, nooit schrijven.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';

export class ForbiddenReadError extends Error {
  constructor(path: string, reason: string) {
    super(`Lezen geweigerd: ${path} (${reason})`);
    this.name = 'ForbiddenReadError';
  }
}

/** Bestanden die de app nooit opent. admin.md bevat MRR, contract en NAW: alleen voor het team. */
export const FORBIDDEN_FILES = new Set(['admin.md']);

export class RepoReader {
  readonly root: string;
  /** Voor tests en audit: elk bestand dat is geopend. */
  readonly opened: string[] = [];

  constructor(root: string) {
    this.root = resolve(root);
  }

  private safe(rel: string): string {
    const abs = resolve(this.root, rel);
    const r = relative(this.root, abs);
    if (r.startsWith('..') || r.split(sep).includes('..') || resolve(abs) === resolve(this.root, '..')) {
      throw new ForbiddenReadError(rel, 'buiten de repo');
    }
    if (FORBIDDEN_FILES.has(basename(abs).toLowerCase()))
      throw new ForbiddenReadError(rel, 'admin.md is nooit leesbaar');
    return abs;
  }

  /** Lees een tekstbestand; ontbreekt het, dan "" (zoals read() in de Python-versie). */
  read(rel: string): string {
    const abs = this.safe(rel);
    if (!existsSync(abs)) return '';
    this.opened.push(relative(this.root, abs));
    return readFileSync(abs, 'utf8');
  }

  isDir(rel: string): boolean {
    const abs = this.safe(rel);
    return existsSync(abs) && statSync(abs).isDirectory();
  }

  /** Bestandsnamen in een map (admin.md wordt nooit teruggegeven). */
  list(rel: string): string[] {
    const abs = this.safe(rel);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return [];
    return readdirSync(abs).filter((f) => !FORBIDDEN_FILES.has(f.toLowerCase()));
  }

  /** Korte HEAD-hash, of "" als het geen git-repo is. */
  head(): string {
    try {
      return execFileSync('git', ['-C', this.root, 'rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return '';
    }
  }
}
