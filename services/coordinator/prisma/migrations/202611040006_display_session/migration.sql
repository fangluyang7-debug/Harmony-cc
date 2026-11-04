CREATE TABLE "DisplaySession" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "groupId" TEXT NOT NULL,
  "sourceHolderId" TEXT NOT NULL,
  "viewerHolderId" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "viewVersion" INTEGER NOT NULL DEFAULT 0,
  "shownVersion" INTEGER NOT NULL DEFAULT 0,
  "content" TEXT,
  "expiresAt" BIGINT NOT NULL
);
CREATE INDEX "DisplaySession_groupId_viewerHolderId_state_idx" ON "DisplaySession"("groupId","viewerHolderId","state");
