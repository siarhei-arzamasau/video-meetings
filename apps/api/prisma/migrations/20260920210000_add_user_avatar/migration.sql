-- Avatars on the user record: the object's key, and a counter that changes whenever the
-- image does. Both are additive and the column is nullable, so every existing row stays
-- valid with no avatar and version 0.
ALTER TABLE "users" ADD COLUMN "avatar_key" TEXT;
ALTER TABLE "users" ADD COLUMN "avatar_version" INTEGER NOT NULL DEFAULT 0;
