CREATE TABLE "ConsoleApp" ("id" TEXT NOT NULL PRIMARY KEY, "groupId" TEXT NOT NULL, "principalId" TEXT NOT NULL, "holderInstanceId" TEXT NOT NULL, "appId" TEXT NOT NULL, "appInstanceId" TEXT NOT NULL);
CREATE UNIQUE INDEX "ConsoleApp_groupId_principalId_holderInstanceId_key" ON "ConsoleApp"("groupId", "principalId", "holderInstanceId");
