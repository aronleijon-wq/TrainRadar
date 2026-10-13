/**
 * Common train format that every data-source adapter normalizes into.
 * Shared by the /api/trains server route and the map client.
 */
export type Country = "SE" | "FI";

export type SourceId = "trafikverket" | "digitraffic";

export type Train = {
  /** Stable id: `<source>:<departureDate>:<trainNo>` */
  id: string;
  country: Country;
  source: SourceId;
  trainNo: string;
  departureDate: string | null;
  operator: string | null;
  /** Product / train type, e.g. "X2000", "Pendeltåg", "IC" */
  product: string | null;
  lat: number;
  lon: number;
  /** km/h */
  speed: number | null;
  /** Degrees clockwise from north */
  bearing: number | null;
  /** Minutes late at the last passed station (negative = early) */
  delayMin: number | null;
  lastStation: string | null;
  nextStation: string | null;
  destination: string | null;
  /** ISO timestamp of the position fix */
  updatedAt: string;
};

export type SourceStatus = {
  id: SourceId;
  country: Country;
  /** False when the source needs credentials that are not set */
  configured: boolean;
  ok: boolean;
  count: number;
  error: string | null;
};

export type TrainsResponse = {
  generatedAt: string;
  trains: Train[];
  sources: SourceStatus[];
};
