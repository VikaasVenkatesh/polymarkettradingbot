import { cronAuthorized } from "@/lib/auth";
import { refreshLeaderboard } from "@/lib/engine";

export const maxDuration = 60;

export async function GET(req: Request) {
  if (!cronAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    return Response.json(await refreshLeaderboard());
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
