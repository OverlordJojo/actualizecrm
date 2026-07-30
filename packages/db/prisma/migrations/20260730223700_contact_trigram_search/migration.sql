-- Trigram indexes for the calendar lead picker (§2.3).
--
-- The picker searches first name, last name, company, phone (raw and E.164),
-- email and location with partial, case-insensitive matching. A plain B-tree
-- cannot serve `ILIKE '%foo%'` — Postgres would sequential-scan the whole
-- contact table on every keystroke, which is unusable once the list is large.
-- pg_trgm + GIN makes those substring matches index-backed.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Contact_firstName_trgm"
  ON "Contact" USING GIN ("firstName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Contact_lastName_trgm"
  ON "Contact" USING GIN ("lastName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Contact_companyName_trgm"
  ON "Contact" USING GIN ("companyName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Contact_email_trgm"
  ON "Contact" USING GIN ("email" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Contact_phone_trgm"
  ON "Contact" USING GIN ("phone" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Contact_companyLocation_trgm"
  ON "Contact" USING GIN ("companyLocation" gin_trgm_ops);
