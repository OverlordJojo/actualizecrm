-- DropIndex
DROP INDEX "Activity_body_trgm";

-- DropIndex
DROP INDEX "Activity_summary_trgm";

-- DropIndex
DROP INDEX "Call_notes_trgm";

-- DropIndex
DROP INDEX "Call_transcript_trgm";

-- DropIndex
DROP INDEX "Contact_companyLocation_trgm";

-- DropIndex
DROP INDEX "Contact_companyName_trgm";

-- DropIndex
DROP INDEX "Contact_email_trgm";

-- DropIndex
DROP INDEX "Contact_firstName_trgm";

-- DropIndex
DROP INDEX "Contact_lastName_trgm";

-- DropIndex
DROP INDEX "Contact_phone_trgm";

-- DropIndex
DROP INDEX "EmailMessage_body_trgm";

-- DropIndex
DROP INDEX "Message_body_trgm";

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "bridgedAt" TIMESTAMP(3),
ADD COLUMN     "heldAt" TIMESTAMP(3),
ADD COLUMN     "sessionId" TEXT;

-- AlterTable
ALTER TABLE "DialSession" ADD COLUMN     "conferenceId" TEXT,
ADD COLUMN     "conferenceName" TEXT,
ADD COLUMN     "linesPerBurst" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "operatorLegId" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'starting';

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DialSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
