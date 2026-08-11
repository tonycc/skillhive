import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export * from "./schema.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/skillhive";

const pool = new Pool({ connectionString });

export const db = drizzle(pool, { schema });
export type DB = typeof db;
