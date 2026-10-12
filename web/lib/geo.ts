import { fetchGeoblock, type Geo } from "./polymarket";

let cached: { at: number; geo: Geo } | null = null;

/** Server-region geoblock status, cached for ten minutes. */
export async function serverGeo(): Promise<Geo> {
  if (!cached || Date.now() - cached.at > 10 * 60_000) {
    cached = { at: Date.now(), geo: await fetchGeoblock() };
  }
  return cached.geo;
}

/** Countries whose residents may not switch on live trading, from the visitor's IP. */
export function visitorRestricted(req: Request): string | null {
  const country = req.headers.get("x-vercel-ip-country");
  const restricted = (process.env.RESTRICTED_COUNTRIES ?? "US").split(",").map((c) => c.trim().toUpperCase());
  return country && restricted.includes(country.toUpperCase()) ? country : null;
}
