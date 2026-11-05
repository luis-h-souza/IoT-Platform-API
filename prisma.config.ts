import "dotenv/config";
import { defineConfig } from "prisma/config";
import { env } from "./src/config/env.js";

const databaseUrl =
  env.NODE_ENV === "test" ? env.TEST_DATABASE_URL : env.DIRECT_URL;

if (!databaseUrl) {
  throw new Error(
    env.NODE_ENV === "test"
      ? "TEST_DATABASE_URL não configurada."
      : "DIRECT_URL não configurada.",
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl,
  },
});
