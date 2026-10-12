import bcrypt from "bcryptjs";
import { endSession, startSession } from "@/lib/auth";
import { q } from "@/lib/db";

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (body.action === "logout") {
    await endSession();
    return Response.json({ ok: true });
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad("Enter a valid email address.");

  if (body.action === "signup") {
    if (password.length < 10) return bad("Password must be at least 10 characters.");
    const hash = await bcrypt.hash(password, 12);
    const rows = await q<{ id: number }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id",
      [email, hash],
    );
    if (!rows.length) return bad("An account with that email already exists.", 409);
    await q("INSERT INTO settings (user_id) VALUES ($1)", [rows[0].id]);
    await startSession(rows[0].id);
    return Response.json({ ok: true });
  }

  if (body.action === "login") {
    const [user] = await q<{ id: number; password_hash: string }>(
      "SELECT id, password_hash FROM users WHERE email = $1",
      [email],
    );
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return bad("Wrong email or password.", 401);
    }
    await startSession(user.id);
    return Response.json({ ok: true });
  }

  return bad("Unknown action.");
}
