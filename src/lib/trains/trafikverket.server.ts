/**
 * Sweden — Trafikverket öppet API (api.trafikinfo.trafikverket.se). CC0 data,
 * requires a free key from https://data.trafikverket.se — set it as the
 * `TRAFIKVERKET_API_KEY` environment variable.
 *
 * One request carries three queries: live TrainPosition, the latest passed
 * TrainAnnouncement per train (delay, operator, product, destination) and the
 * upcoming arrivals (next station). Station names are cached separately.
 */
import type { Train } from "./types";

const ENDPOINT = "https://api.trafikinfo.trafikverket.se/v2/data.json";
const STATION_TTL_MS = 12 * 60 * 60 * 1000;

export type TvPosition = {
  Train?: {
    AdvertisedTrainNumber?: string;
    OperationalTrainNumber?: string;
    OperationalTrainDepartureDate?: string;
    JourneyPlanDepartureDate?: string;
  };
  Position?: { WGS84?: string };
  TimeStamp?: string;
  Bearing?: number;
  Speed?: number;
};

export type TvAnnouncement = {
  AdvertisedTrainIdent?: string;
  ScheduledDepartureDateTime?: string;
  AdvertisedTimeAtLocation?: string;
  TimeAtLocation?: string;
  LocationSignature?: string;
  ActivityType?: string;
  Operator?: string;
  ProductInformation?: { Code?: string; Description?: string }[];
  ToLocation?: { LocationName?: string; Priority?: number; Order?: number }[];
};

export type TvStation = { LocationSignature?: string; AdvertisedLocationName?: string };

type TvResult = Record<string, unknown> & { ERROR?: { SOURCE?: string; MESSAGE?: string } };

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

function trainsRequest(key: string) {
  const announcementFields = [
    "AdvertisedTrainIdent",
    "ScheduledDepartureDateTime",
    "AdvertisedTimeAtLocation",
    "TimeAtLocation",
    "LocationSignature",
    "ActivityType",
    "Operator",
    "ProductInformation",
    "ToLocation",
  ]
    .map((f) => `<INCLUDE>${f}</INCLUDE>`)
    .join("");

  return `<REQUEST>
  <LOGIN authenticationkey="${escapeXml(key)}" />
  <QUERY objecttype="TrainPosition" namespace="järnväg.trafikinfo" schemaversion="1.1">
    <FILTER>
      <AND>
        <EQ name="Status.Active" value="true" />
        <GT name="TimeStamp" value="$dateadd(-0.00:10:00)" />
      </AND>
    </FILTER>
  </QUERY>
  <QUERY objecttype="TrainAnnouncement" schemaversion="1.9" orderby="TimeAtLocation desc">
    <FILTER>
      <GT name="TimeAtLocation" value="$dateadd(-0.02:00:00)" />
    </FILTER>
    ${announcementFields}
  </QUERY>
  <QUERY objecttype="TrainAnnouncement" schemaversion="1.9" orderby="AdvertisedTimeAtLocation asc">
    <FILTER>
      <AND>
        <EQ name="ActivityType" value="Ankomst" />
        <EQ name="Advertised" value="true" />
        <EXISTS name="TimeAtLocation" value="false" />
        <GT name="AdvertisedTimeAtLocation" value="$dateadd(-0.02:00:00)" />
        <LT name="AdvertisedTimeAtLocation" value="$dateadd(0.04:00:00)" />
      </AND>
    </FILTER>
    <INCLUDE>AdvertisedTrainIdent</INCLUDE>
    <INCLUDE>ScheduledDepartureDateTime</INCLUDE>
    <INCLUDE>LocationSignature</INCLUDE>
  </QUERY>
</REQUEST>`;
}

function stationsRequest(key: string) {
  return `<REQUEST>
  <LOGIN authenticationkey="${escapeXml(key)}" />
  <QUERY objecttype="TrainStation" schemaversion="1.4">
    <INCLUDE>LocationSignature</INCLUDE>
    <INCLUDE>AdvertisedLocationName</INCLUDE>
  </QUERY>
</REQUEST>`;
}

async function post(body: string): Promise<TvResult[]> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", Accept: "application/json" },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Trafikverket HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const json = (await res.json()) as { RESPONSE?: { RESULT?: TvResult[] } };
  const results = json.RESPONSE?.RESULT ?? [];
  const failed = results.find((r) => r.ERROR);
  if (failed?.ERROR) throw new Error(`Trafikverket: ${failed.ERROR.MESSAGE ?? "unknown error"}`);
  return results;
}

let stationCache: { at: number; names: Map<string, string> } | null = null;

async function getStationNames(key: string): Promise<Map<string, string>> {
  if (stationCache && Date.now() - stationCache.at < STATION_TTL_MS) return stationCache.names;
  try {
    const [result] = await post(stationsRequest(key));
    const stations = (result?.["TrainStation"] as TvStation[] | undefined) ?? [];
    const names = new Map<string, string>();
    for (const s of stations) {
      if (s.LocationSignature && s.AdvertisedLocationName) {
        names.set(s.LocationSignature, s.AdvertisedLocationName);
      }
    }
    stationCache = { at: Date.now(), names };
    return names;
  } catch (error) {
    console.warn("[trafikverket] station lookup failed", error);
    return stationCache?.names ?? new Map();
  }
}

/** "POINT (18.0583 59.3313)" → [lon, lat] */
export function parseWgs84(point: string | undefined): [number, number] | null {
  const m = point?.match(/POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i);
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

const day = (iso: string | undefined) => iso?.slice(0, 10) ?? "";

/** Index announcements by date+train and by train alone; first occurrence wins. */
function indexAnnouncements(list: TvAnnouncement[]) {
  const byDate = new Map<string, TvAnnouncement>();
  const byTrain = new Map<string, TvAnnouncement>();
  for (const a of list) {
    if (!a.AdvertisedTrainIdent) continue;
    const dated = `${day(a.ScheduledDepartureDateTime)}:${a.AdvertisedTrainIdent}`;
    if (!byDate.has(dated)) byDate.set(dated, a);
    if (!byTrain.has(a.AdvertisedTrainIdent)) byTrain.set(a.AdvertisedTrainIdent, a);
  }
  return (trainNo: string, date: string) =>
    byDate.get(`${date}:${trainNo}`) ?? byTrain.get(trainNo);
}

export function normalizeTrafikverket(
  positions: TvPosition[],
  passed: TvAnnouncement[],
  upcoming: TvAnnouncement[],
  stationNames: Map<string, string>,
): Train[] {
  const lastPassed = indexAnnouncements(passed);
  const nextArrival = indexAnnouncements(upcoming);
  const name = (sig: string | undefined) => (sig ? (stationNames.get(sig) ?? sig) : null);

  const trains = new Map<string, Train>();
  for (const p of positions) {
    const coords = parseWgs84(p.Position?.WGS84);
    const trainNo = p.Train?.AdvertisedTrainNumber ?? p.Train?.OperationalTrainNumber;
    if (!coords || !trainNo) continue;

    const date = day(p.Train?.JourneyPlanDepartureDate ?? p.Train?.OperationalTrainDepartureDate);
    const last = lastPassed(trainNo, date);
    const next = nextArrival(trainNo, date);

    let delayMin: number | null = null;
    if (last?.TimeAtLocation && last.AdvertisedTimeAtLocation) {
      delayMin = Math.round(
        (Date.parse(last.TimeAtLocation) - Date.parse(last.AdvertisedTimeAtLocation)) / 60000,
      );
    }
    const destination = [...(last?.ToLocation ?? [])].sort(
      (a, b) => (a.Priority ?? 0) - (b.Priority ?? 0),
    )[0]?.LocationName;

    const id = `trafikverket:${date}:${trainNo}`;
    const existing = trains.get(id);
    // Keep the freshest fix if a train is reported twice.
    if (existing && existing.updatedAt >= (p.TimeStamp ?? "")) continue;

    trains.set(id, {
      id,
      country: "SE",
      source: "trafikverket",
      trainNo,
      departureDate: date || null,
      operator: last?.Operator ?? null,
      product: last?.ProductInformation?.[0]?.Description ?? null,
      lat: coords[1],
      lon: coords[0],
      speed: typeof p.Speed === "number" ? p.Speed : null,
      bearing: typeof p.Bearing === "number" ? p.Bearing : null,
      delayMin: Number.isFinite(delayMin) ? delayMin : null,
      lastStation: name(last?.LocationSignature),
      nextStation: name(next?.LocationSignature),
      destination: name(destination),
      updatedAt: p.TimeStamp ?? new Date().toISOString(),
    });
  }
  return [...trains.values()];
}

export async function fetchTrafikverket(key: string): Promise<Train[]> {
  const [results, stationNames] = await Promise.all([
    post(trainsRequest(key)),
    getStationNames(key),
  ]);
  const positions = (results[0]?.["TrainPosition"] as TvPosition[] | undefined) ?? [];
  const passed = (results[1]?.["TrainAnnouncement"] as TvAnnouncement[] | undefined) ?? [];
  const upcoming = (results[2]?.["TrainAnnouncement"] as TvAnnouncement[] | undefined) ?? [];
  return normalizeTrafikverket(positions, passed, upcoming, stationNames);
}
