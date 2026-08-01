-- Trigram indexes for the Conversations search box (build step 7).
--
-- The search is one box over everything the operator might remember: a phrase
-- from a note, a line someone said on a call, the body of a text or an email.
-- All of those are `ILIKE '%...%'` against long text columns, which a B-tree
-- cannot serve at all.
--
-- Call.transcript is the one that actually forces this. At ~1,200 dials a day
-- the Call table passes a million rows inside a year, and each transcript row
-- is kilobytes of text; a sequential scan per keystroke is not a slow search,
-- it is a search the operator stops using.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Activity_summary_trgm"
  ON "Activity" USING GIN ("summary" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Activity_body_trgm"
  ON "Activity" USING GIN ("body" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Call_transcript_trgm"
  ON "Call" USING GIN ("transcript" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Call_notes_trgm"
  ON "Call" USING GIN ("notes" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Message_body_trgm"
  ON "Message" USING GIN ("body" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "EmailMessage_body_trgm"
  ON "EmailMessage" USING GIN ("body" gin_trgm_ops);
