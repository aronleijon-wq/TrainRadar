/**
 * Finland — Fintraffic Digitraffic (rata.digitraffic.fi). Open data, no API key.
 *
 * Positions come from the REST `train-locations/latest` endpoint. Train type,
 * operator, delay and stations come from the GraphQL `currentlyRunningTrains`
 * query; if that enrichment fails we still return bare positions.
 */
import type { Train } from "./types";

const BASE = "https://rata.digitraffic.fi";
const HEADERS = { "Digitraffic-User": "TrainRadar", Accept: "application/json" };

export type DtLocation = {
  trainNumber: number;
  departureDate: string;
  timestamp: string;
  location: { type: string; coordinates: [number, number] };
  speed?: number | null;
};

export type DtTimeTableRow = {
  type: "ARRIVAL" | "DEPARTURE";
  trainStopping: boolean;
  commercialStop?: boolean | null;
  scheduledTime: string;
  actualTime?: string | null;
  differenceInMinutes?: number | null;
  station?: { name?: string | null; shortCode?: string | null } | null;
};

export type DtTrain = {
  trainNumber: number;
  departureDate: string;
  operator?: { shortCode?: string | null } | null;
  trainType?: { name?: string | null } | null;
  timeTableRows?: DtTimeTableRow[] | null;
};

const RUNNING_TRAINS_QUERY = `{
  currentlyRunningTrains {
    trainNumber
    departureDate
    operator { shortCode }
    trainType { name }
    timeTableRows {
      type
      trainStopping
      commercialStop
      scheduledTime
      actualTime
      differenceInMinutes
      station { name shortCode }
    }
  }
}`;

const OPERATOR_NAMES: Record<string, string> = {
  vr: "VR",
  "vr-track": "VR Track",
  fenniarail: "Fenniarail",
  "pohjolan-liikenne": "Pohjolan Liikenne",
};

function stationName(row: DtTimeTableRow | undefined): string | null {
  const name = row?.station?.name ?? row?.station?.shortCode ?? null;
  return name ? name.replace(/ asema$/i, "") : null;
}

function key(trainNumber: number, departureDate: string) {
  return `${departureDate}:${trainNumber}`;
}

export function normalizeDigitraffic(locations: DtLocation[], details: DtTrain[]): Train[] {
  const byKey = new Map(details.map((t) => [key(t.trainNumber, t.departureDate), t]));

  const trains: Train[] = [];
  for (const loc of locations) {
    const [lon, lat] = loc.location?.coordinates ?? [];
    if (typeof lat !== "number" || typeof lon !== "number") continue;

    const detail = byKey.get(key(loc.trainNumber, loc.departureDate));
    const rows = detail?.timeTableRows ?? [];
    const passed = rows.filter((r) => r.actualTime);
    const lastPassed = passed.at(-1);
    const nextStop = rows.find(
      (r) => !r.actualTime && r.trainStopping && r.commercialStop !== false && r.type === "ARRIVAL",
    );
    const opCode = detail?.operator?.shortCode ?? null;
    const typeName = detail?.trainType?.name ?? null;

    trains.push({
      id: `digitraffic:${loc.departureDate}:${loc.trainNumber}`,
      country: "FI",
      source: "digitraffic",
      trainNo: typeName ? `${typeName} ${loc.trainNumber}` : String(loc.trainNumber),
      departureDate: loc.departureDate,
      operator: opCode ? (OPERATOR_NAMES[opCode] ?? opCode) : null,
      product: typeName,
      lat,
      lon,
      speed: typeof loc.speed === "number" ? loc.speed : null,
      bearing: null,
      delayMin: lastPassed?.differenceInMinutes ?? null,
      lastStation: stationName(lastPassed),
      nextStation: stationName(nextStop),
      destination: stationName(rows.at(-1)),
      updatedAt: loc.timestamp,
    });
  }
  return trains;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...HEADERS, ...init?.headers },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function fetchDetails(): Promise<DtTrain[]> {
  try {
    const body = await fetchJson<{
      data?: { currentlyRunningTrains?: DtTrain[] };
      errors?: unknown;
    }>(`${BASE}/api/v2/graphql/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: RUNNING_TRAINS_QUERY }),
    });
    if (body.errors) console.warn("[digitraffic] GraphQL errors", body.errors);
    return body.data?.currentlyRunningTrains ?? [];
  } catch (error) {
    console.warn("[digitraffic] enrichment failed, returning bare positions", error);
    return [];
  }
}

export async function fetchDigitraffic(): Promise<Train[]> {
  const [locations, details] = await Promise.all([
    fetchJson<DtLocation[]>(`${BASE}/api/v1/train-locations/latest/`),
    fetchDetails(),
  ]);
  return normalizeDigitraffic(locations, details);
}
