import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Prisma 7 does not read .env by itself. In Docker there is no .env: the variables come from compose.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Not needed by `prisma generate` (Docker build); migrate commands stop without it
  datasource: { url: process.env.DATABASE_URL },
});
