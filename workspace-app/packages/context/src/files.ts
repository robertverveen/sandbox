/** Export lezen en schrijven als losse JSON-bestanden (zelfde mapvorm als export_context.py). */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextSnapshot } from '@hz/shared';
import { ContextSnapshot as SnapshotSchema } from '@hz/shared';
import { toSnapshot, type ExportDocs } from './export';

export const COLLECTIONS = ['context_partners', 'context_acties', 'context_persoonlijk', 'context_status'] as const;

export function writeExport(outDir: string, docs: ExportDocs): Record<string, string[]> {
  const manifest: Record<string, string[]> = {};
  for (const col of COLLECTIONS) {
    const items = docs[col] as Record<string, unknown>;
    mkdirSync(join(outDir, col), { recursive: true });
    for (const [id, data] of Object.entries(items))
      writeFileSync(join(outDir, col, id + '.json'), JSON.stringify(data));
    manifest[col] = Object.keys(items).sort();
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  return manifest;
}

/** Lees een export-map (bijv. HZ_CONTEXT_EXPORT) als snapshot. Alleen runtime; nooit committen. */
export function readExport(dir: string): ContextSnapshot {
  const docs: Record<string, Record<string, unknown>> = {};
  for (const col of COLLECTIONS) {
    const d = join(dir, col);
    docs[col] = {};
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.json')) continue;
      docs[col]![f.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(d, f), 'utf8'));
    }
  }
  return SnapshotSchema.parse(toSnapshot(docs));
}
