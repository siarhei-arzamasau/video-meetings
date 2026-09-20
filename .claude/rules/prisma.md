---
globs: '**/*.prisma'
---

# Prisma Rules

- UUID for every id: `@id @default(uuid())`
- Always add `createdAt` and `updatedAt`
- Enum values in UPPER_CASE
- Relations through `@relation` with an explicit name
- Indexes on foreign keys through `@@index`
