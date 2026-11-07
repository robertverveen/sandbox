-- Briefings krijgen een extra-kolom (stuk E2, HZW-021): velden uit het prototype zonder eigen kolom blijven bewaard.
-- Gegenereerd met drizzle-kit (schema.ts), commentaar met de hand.
ALTER TABLE "briefings" ADD COLUMN "extra" jsonb DEFAULT '{}'::jsonb NOT NULL;