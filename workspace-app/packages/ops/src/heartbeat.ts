/**
 * Hartslag van de worker (HZW-007): elke interval wordt een bestand bijgewerkt. De Docker-healthcheck kijkt of het
 * bestand recent is; staat de event-loop stil of hangt de worker, dan wordt de container 'unhealthy' en herstart.
 */
import { statSync, writeFileSync } from 'node:fs';

export function startHeartbeat(file: string | undefined, intervalMs = 30_000): () => void {
  if (!file) return () => {};
  const beat = () => {
    try {
      writeFileSync(file, String(Date.now()));
    } catch {
      /* schijf vol of map weg: de healthcheck merkt het */
    }
  };
  beat();
  const t = setInterval(beat, intervalMs);
  t.unref();
  return () => clearInterval(t);
}

/** true als het hartslagbestand jonger is dan maxAgeMs (gebruikt door de healthcheck). */
export function heartbeatFresh(file: string, maxAgeMs = 90_000, now = Date.now()): boolean {
  try {
    return now - statSync(file).mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}
