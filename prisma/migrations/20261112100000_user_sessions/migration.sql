-- Sessions that can be ended (#145): every session carries the user's
-- sessionVersion and is refused once it changes, or once the user is disabled.
ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "disabledAt" TIMESTAMP(3);
