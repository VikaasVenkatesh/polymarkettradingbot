import { cronAuthorized } from "@/lib/auth";
import { refreshLeaderboard } from "@/lib/engine";
import { PERIODS } from "@/lib/polymarket";

export const maxDuration = 60;

export async function GET(req: Request) {
  if (!cronAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    // Runs daily: "today" needs a fresh list every day, the longer periods refresh on Mondays.
    const monday = new Date().getUTCDay() === 1;
    const all = monday || new URL(req.url).searchParams.has("all");
    return Response.json(await refreshLeaderboard(all ? PERIODS : ["DAY"]));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
