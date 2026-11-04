ALTER TABLE "RegisteredApp" ADD COLUMN "batchWeight" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "RegisteredApp" ADD COLUMN "batchService" REAL NOT NULL DEFAULT 0;
CREATE TABLE "BatchCharge" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "appId" TEXT NOT NULL,
  "estimatedMs" REAL NOT NULL,
  "rate" REAL NOT NULL,
  "actualMs" REAL
);
