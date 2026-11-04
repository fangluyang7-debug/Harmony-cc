CREATE TABLE "BatchReadyJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "groupId" TEXT NOT NULL,
  "appId" TEXT NOT NULL,
  "peerJson" TEXT NOT NULL,
  "queuedAt" REAL NOT NULL,
  "deadlineAt" REAL NOT NULL,
  "reason" TEXT NOT NULL
);
CREATE INDEX "BatchReadyJob_groupId_queuedAt_idx" ON "BatchReadyJob"("groupId","queuedAt");
