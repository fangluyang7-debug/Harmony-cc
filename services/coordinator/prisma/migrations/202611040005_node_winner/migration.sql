ALTER TABLE "Node" ADD COLUMN "primaryAttemptId" TEXT;
ALTER TABLE "Node" ADD COLUMN "backupAttemptId" TEXT;
ALTER TABLE "Node" ADD COLUMN "winnerAttemptId" TEXT;
UPDATE "Node" SET "primaryAttemptId" = "currentAttemptId", "winnerAttemptId" = CASE WHEN "state" = 'COMMITTED' THEN "currentAttemptId" ELSE NULL END;
