CREATE TABLE IF NOT EXISTS "RuntimeCapabilityApproval" (
  "capability" TEXT NOT NULL, "deviceId" TEXT NOT NULL, "executorVersion" TEXT NOT NULL,
  "approved" BOOLEAN NOT NULL, "reviewer" TEXT NOT NULL, "reason" TEXT NOT NULL,
  "observedAt" DATETIME NOT NULL, "expiresAt" DATETIME NOT NULL,
  PRIMARY KEY ("capability", "deviceId", "executorVersion")
);
