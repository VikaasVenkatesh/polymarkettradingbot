import { Pool } from "pg";

const globalForPg = globalThis as unknown as { pgPool?: Pool; pgSchema?: Promise<void> };

function pool(): Pool {
  if (!globalForPg.pgPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    globalForPg.pgPool = new Pool({ connectionString, max: 3 });
  }
  return globalForPg.pgPool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  budget_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  top_traders INTEGER NOT NULL DEFAULT 5,
  top_positions INTEGER NOT NULL DEFAULT 3,
  live BOOLEAN NOT NULL DEFAULT false,
  paused BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  funder_address TEXT,
  signature_type INTEGER NOT NULL DEFAULT 0,
  enc_private_key TEXT NOT NULL,
  enc_api_creds TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS leaderboard (
  rank INTEGER PRIMARY KEY,
  address TEXT NOT NULL,
  name TEXT NOT NULL,
  pnl DOUBLE PRECISION NOT NULL,
  volume DOUBLE PRECISION NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS trader_positions (
  address TEXT PRIMARY KEY,
  fetched_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS copied_positions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trader_address TEXT NOT NULL,
  trader_name TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  title TEXT NOT NULL,
  outcome TEXT NOT NULL,
  shares DOUBLE PRECISION NOT NULL,
  cost_usd DOUBLE PRECISION NOT NULL,
  proceeds_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS copied_positions_open_idx
  ON copied_positions (user_id, trader_address, token_id, mode) WHERE status = 'open';
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  side TEXT NOT NULL,
  token_id TEXT NOT NULL,
  title TEXT NOT NULL,
  outcome TEXT NOT NULL,
  trader_name TEXT NOT NULL,
  usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  shares DOUBLE PRECISION NOT NULL DEFAULT 0,
  price DOUBLE PRECISION NOT NULL DEFAULT 0,
  mode TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS runs (
  kind TEXT PRIMARY KEY,
  locked_until TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  finished_at TIMESTAMPTZ,
  summary JSONB
);
INSERT INTO runs (kind) VALUES ('scan'), ('leaderboard') ON CONFLICT DO NOTHING;
`;

export async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  if (!globalForPg.pgSchema) {
    globalForPg.pgSchema = pool()
      .query(SCHEMA)
      .then(() => undefined)
      .catch((e) => {
        globalForPg.pgSchema = undefined;
        throw e;
      });
  }
  await globalForPg.pgSchema;
  const res = await pool().query(text, params);
  return res.rows as T[];
}
