-- Per-number inbound routing (add-on A).
--
-- Defaults to true because the alternative — owning numbers that ring nowhere
-- when a prospect calls back — quietly wastes the callbacks that cold calling
-- is trying to generate.

ALTER TABLE "PhoneNumber"
  ADD COLUMN IF NOT EXISTS "routeInboundToBrowser" BOOLEAN NOT NULL DEFAULT true;
