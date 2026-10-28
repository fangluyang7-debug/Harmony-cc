CREATE TABLE IF NOT EXISTS "RuntimeCostObservation" (
  "id" TEXT NOT NULL PRIMARY KEY, "sampleKey" TEXT NOT NULL,
  "capability" TEXT NOT NULL, "deviceId" TEXT NOT NULL, "scope" TEXT NOT NULL,
  "sizeBucket" INTEGER NOT NULL, "configuration" TEXT NOT NULL,
  "executorVersion" TEXT NOT NULL, "networkId" TEXT NOT NULL,
  "durationMs" REAL NOT NULL, "success" BOOLEAN NOT NULL, "source" TEXT NOT NULL,
  "errorClass" TEXT, "bytes" INTEGER, "observedAt" DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS "RuntimeCostObservation_sampleKey_observedAt_idx" ON "RuntimeCostObservation"("sampleKey", "observedAt");
CREATE INDEX IF NOT EXISTS "RuntimeCostObservation_capability_deviceId_scope_executorVersion_observedAt_idx" ON "RuntimeCostObservation"("capability", "deviceId", "scope", "executorVersion", "observedAt");
CREATE INDEX IF NOT EXISTS "RuntimeCostObservation_observedAt_idx" ON "RuntimeCostObservation"("observedAt");
CREATE TABLE IF NOT EXISTS "RuntimeCalibrationQuota" (
  "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "deviceId" TEXT NOT NULL,
  "day" TEXT NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS "RuntimeQualityEvidence" (
  "id" TEXT NOT NULL PRIMARY KEY, "deviceId" TEXT NOT NULL, "executorVersion" TEXT NOT NULL,
  "policyHash" TEXT NOT NULL, "passed" BOOLEAN NOT NULL,
  "resultsJson" TEXT NOT NULL, "observedAt" DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS "RuntimeQualityEvidence_deviceId_executorVersion_policyHash_observedAt_idx" ON "RuntimeQualityEvidence"("deviceId", "executorVersion", "policyHash", "observedAt");
