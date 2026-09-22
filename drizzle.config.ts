/** drizzle-kit 只在开发时用：`pnpm db:generate` 按 src/db/schema.ts 生成迁移到 drizzle/ */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
