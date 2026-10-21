CREATE TABLE IF NOT EXISTS "RuntimeDevice" (
  "id" TEXT NOT NULL PRIMARY KEY, "kind" TEXT NOT NULL, "ownerUserId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active', "connectionJson" TEXT, "profileJson" TEXT, "observedAt" DATETIME
);
CREATE TABLE IF NOT EXISTS "RuntimeCostSample" (
  "id" TEXT NOT NULL PRIMARY KEY, "sampleJson" TEXT NOT NULL, "observedAt" DATETIME NOT NULL
);
