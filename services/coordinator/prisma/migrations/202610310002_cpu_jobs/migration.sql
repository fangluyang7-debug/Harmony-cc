CREATE TABLE "CpuJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "groupId" TEXT NOT NULL,
  "principalId" TEXT NOT NULL,
  "sourceHolderId" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "metadataJson" TEXT NOT NULL
);
CREATE INDEX "CpuJob_groupId_principalId_idx" ON "CpuJob"("groupId", "principalId");
