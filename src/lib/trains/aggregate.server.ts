/**
 * Runs every source adapter, merges the results into one TrainsResponse and
 * caches it briefly so many map clients share one upstream fetch.
 */
import { fetchDigitraffic } from "./digitraffic.server";
import { fetchTrafikverket } from "./trafikverket.server";
import type { Country, SourceId, SourceStatus, Train, TrainsResponse } from "./types";

const CACHE_TTL_MS = 10_000;

type Source = {
  id: SourceId;
  country: Country;
  /** Returns null when the source is not configured (e.g. missing key). */
  fetch: () => Promise<Train[]> | null;
};

function env(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env[name] : undefined;
}

const SOURCES: Source[] = [
  {
    id: "trafikverket",
    country: "SE",
    fetch: () => {
      const key = env("TRAFIKVERKET_API_KEY");
      return key ? fetchTrafikverket(key) : null;
    },
  },
  { id: "digitraffic", country: "FI", fetch: () => fetchDigitraffic() },
];

/** Bearing in degrees from point a to point b. */
export function bearingBetween(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [lon1, lat1] = [toRad(a[0]), toRad(a[1])];
  const [lon2, lat2] = [toRad(b[0]), toRad(b[1])];
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Rough distance in metres, good enough to tell "moved" from GPS jitter. */
function metresBetween(a: [number, number], b: [number, number]): number {
  const dLat = (b[1] - a[1]) * 111_320;
  const dLon = (b[0] - a[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

const lastSeen = new Map<string, { pos: [number, number]; bearing: number | null }>();

/** Fill in bearing for sources that don't report one, from the previous fix. */
export function fillBearings(trains: Train[]): Train[] {
  const seen = new Set<string>();
  const out = trains.map((t) => {
    seen.add(t.id);
    const pos: [number, number] = [t.lon, t.lat];
    const prev = lastSeen.get(t.id);
    let bearing = t.bearing;
    if (bearing === null && prev) {
      bearing = metresBetween(prev.pos, pos) > 30 ? bearingBetween(prev.pos, pos) : prev.bearing;
    }
    const moved = !prev || metresBetween(prev.pos, pos) > 30;
    lastSeen.set(t.id, { pos: moved ? pos : prev.pos, bearing });
    return bearing === t.bearing ? t : { ...t, bearing };
  });
  for (const id of lastSeen.keys()) if (!seen.has(id)) lastSeen.delete(id);
  return out;
}

async function runSource(source: Source): Promise<{ status: SourceStatus; trains: Train[] }> {
  const base = { id: source.id, country: source.country };
  let pending: Promise<Train[]> | null;
  try {
    pending = source.fetch();
  } catch (error) {
    pending = Promise.reject(error);
  }
  if (!pending) {
    return {
      status: { ...base, configured: false, ok: false, count: 0, error: "API-nyckel saknas" },
      trains: [],
    };
  }
  try {
    const trains = await pending;
    return {
      status: { ...base, configured: true, ok: true, count: trains.length, error: null },
      trains,
    };
  } catch (error) {
    console.error(`[${source.id}]`, error);
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: { ...base, configured: true, ok: false, count: 0, error: message },
      trains: [],
    };
  }
}

let cache: { at: number; data: TrainsResponse } | null = null;
let inflight: Promise<TrainsResponse> | null = null;

export async function getTrains(): Promise<TrainsResponse> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  if (inflight) return inflight;

  inflight = (async () => {
    const results = await Promise.all(SOURCES.map(runSource));
    const data: TrainsResponse = {
      generatedAt: new Date().toISOString(),
      trains: fillBearings(results.flatMap((r) => r.trains)),
      sources: results.map((r) => r.status),
    };
    cache = { at: Date.now(), data };
    return data;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}
