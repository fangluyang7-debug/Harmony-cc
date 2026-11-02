CREATE TABLE "SdkWorkflowJob" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "groupId" TEXT NOT NULL,
 "sourceHolderId" TEXT NOT NULL,
 "state" TEXT NOT NULL,
 "metadataJson" TEXT NOT NULL
);
CREATE INDEX "SdkWorkflowJob_groupId_state_idx" ON "SdkWorkflowJob"("groupId", "state");
