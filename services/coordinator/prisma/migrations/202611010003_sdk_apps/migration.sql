CREATE TABLE "RegisteredApp" ("id" TEXT NOT NULL PRIMARY KEY, "groupId" TEXT NOT NULL, "principalId" TEXT NOT NULL, "label" TEXT NOT NULL, "contractsJson" TEXT NOT NULL, "resourcesJson" TEXT NOT NULL, "maxConcurrent" INTEGER NOT NULL);
CREATE UNIQUE INDEX "RegisteredApp_groupId_principalId_label_key" ON "RegisteredApp"("groupId", "principalId", "label");
CREATE TABLE "RegisteredInstallation" ("id" TEXT NOT NULL PRIMARY KEY, "appId" TEXT NOT NULL, "groupId" TEXT NOT NULL, "principalId" TEXT NOT NULL, "deviceId" TEXT NOT NULL, "holderInstanceId" TEXT NOT NULL, "state" TEXT NOT NULL, "secretHash" TEXT, "expiresAt" REAL NOT NULL, "offlineJson" TEXT NOT NULL, "onlineJson" TEXT NOT NULL);
CREATE UNIQUE INDEX "RegisteredInstallation_holderInstanceId_key" ON "RegisteredInstallation"("holderInstanceId");
CREATE INDEX "RegisteredInstallation_deviceId_idx" ON "RegisteredInstallation"("deviceId");
CREATE TABLE "AppJobReservation" ("id" TEXT NOT NULL PRIMARY KEY, "appId" TEXT NOT NULL, "groupId" TEXT NOT NULL, "principalId" TEXT NOT NULL, "appInstanceId" TEXT NOT NULL, "resourcesJson" TEXT NOT NULL, "deadlineAt" REAL NOT NULL);
CREATE INDEX "AppJobReservation_groupId_principalId_appId_idx" ON "AppJobReservation"("groupId", "principalId", "appId");
