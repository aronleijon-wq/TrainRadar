import { useEffect, useState } from "react";
import { Crosshair, Gauge, LocateFixed, Navigation, Video, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DELAY_LEVELS, delayLevel, formatDelay } from "@/lib/trains/delay";
import type { Train } from "@/lib/trains/types";
import { cn } from "@/lib/utils";

import type { FollowMode } from "./TrainMap";

export type SpeedSample = { t: number; v: number };

type Props = {
  train: Train;
  stale: boolean;
  speedHistory: SpeedSample[];
  follow: FollowMode;
  onFollow: (mode: FollowMode) => void;
  onZoom: () => void;
  onClose: () => void;
};

const FLAG: Record<Train["country"], string> = { SE: "🇸🇪", FI: "🇫🇮" };
const SOURCE: Record<Train["source"], string> = {
  trafikverket: "Trafikverket",
  digitraffic: "Fintraffic Digitraffic",
};

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function ago(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s sedan`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min sedan` : `${Math.round(m / 60)} h sedan`;
}

function compass(bearing: number) {
  const dirs = ["N", "NO", "O", "SO", "S", "SV", "V", "NV"];
  return dirs[Math.round(bearing / 45) % 8];
}

export function TrainPanel({
  train,
  stale,
  speedHistory,
  follow,
  onFollow,
  onZoom,
  onClose,
}: Props) {
  const now = useNow(1000);
  const level = delayLevel(train.delayMin);
  const color = DELAY_LEVELS[level].color;

  return (
    <div className="pointer-events-auto flex max-h-full flex-col overflow-hidden rounded-xl border border-white/10 bg-slate-950/85 text-slate-100 shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div
        className="relative px-4 pb-3 pt-4"
        style={{ background: `linear-gradient(135deg, ${color}33, transparent 70%)` }}
      >
        <button
          onClick={onClose}
          className="absolute right-3 top-3 rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-white"
          aria-label="Stäng"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-slate-400">
          <span>{FLAG[train.country]}</span>
          <span>{train.product ?? "Tåg"}</span>
          {stale && (
            <span className="rounded bg-amber-500/20 px-1.5 text-amber-300">Ingen signal</span>
          )}
        </div>
        <div className="mt-1 text-2xl font-bold tracking-tight">{train.trainNo}</div>
        <div className="text-sm text-slate-300">{train.operator ?? "Okänd operatör"}</div>
      </div>

      <div className="space-y-4 overflow-y-auto px-4 pb-4">
        {/* Route */}
        <div className="rounded-lg bg-white/5 p-3">
          <div className="flex items-stretch gap-3">
            <div className="flex flex-col items-center py-1">
              <span className="h-2.5 w-2.5 rounded-full bg-slate-500" />
              <span className="my-1 w-px flex-1 bg-gradient-to-b from-slate-500 to-sky-400" />
              <span className="h-2.5 w-2.5 rounded-full bg-sky-400 ring-4 ring-sky-400/20" />
              {train.destination && train.destination !== train.nextStation && (
                <>
                  <span className="my-1 w-px flex-1 border-l border-dashed border-slate-600" />
                  <span className="h-2.5 w-2.5 rounded-full border-2 border-slate-400" />
                </>
              )}
            </div>
            <div className="flex flex-1 flex-col justify-between gap-2 text-sm">
              <div>
                <div className="text-[11px] uppercase text-slate-500">Senast passerad</div>
                <div className="font-medium">{train.lastStation ?? "—"}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase text-slate-500">Nästa station</div>
                <div className="font-medium text-sky-300">{train.nextStation ?? "—"}</div>
              </div>
              {train.destination && train.destination !== train.nextStation && (
                <div>
                  <div className="text-[11px] uppercase text-slate-500">Slutstation</div>
                  <div className="font-medium">{train.destination}</div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Key stats */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label="Försening" value={formatDelay(train.delayMin)} color={color} />
          <Stat
            label="Hastighet"
            value={train.speed !== null ? `${Math.round(train.speed)}` : "—"}
            unit={train.speed !== null ? "km/h" : undefined}
          />
          <Stat
            label="Riktning"
            value={train.bearing !== null ? (compass(train.bearing) ?? "—") : "—"}
            icon={
              train.bearing !== null ? (
                <Navigation
                  className="mx-auto h-3.5 w-3.5 text-sky-300"
                  // lucide's Navigation icon points north-east (45°) at rest.
                  style={{ transform: `rotate(${train.bearing - 45}deg)` }}
                />
              ) : null
            }
          />
        </div>

        {/* Speed graph */}
        <div className="rounded-lg bg-white/5 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase text-slate-500">
            <Gauge className="h-3 w-3" /> Hastighet senaste minuterna
          </div>
          <SpeedSparkline samples={speedHistory} />
        </div>

        {/* Actions */}
        <div className="grid grid-cols-3 gap-2">
          <Button variant="secondary" size="sm" onClick={onZoom} className="gap-1.5">
            <Crosshair className="h-3.5 w-3.5" /> Zooma
          </Button>
          <Button
            variant={follow === "follow" ? "default" : "secondary"}
            size="sm"
            onClick={() => onFollow(follow === "follow" ? "off" : "follow")}
            className="gap-1.5"
          >
            <LocateFixed className="h-3.5 w-3.5" /> Följ
          </Button>
          <Button
            variant={follow === "chase" ? "default" : "secondary"}
            size="sm"
            onClick={() => onFollow(follow === "chase" ? "off" : "chase")}
            className="gap-1.5"
          >
            <Video className="h-3.5 w-3.5" /> 3D-vy
          </Button>
        </div>

        {/* Meta */}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-slate-500">Position</dt>
          <dd className="text-right font-mono text-slate-300">
            {train.lat.toFixed(4)}, {train.lon.toFixed(4)}
          </dd>
          <dt className="text-slate-500">Uppdaterad</dt>
          <dd className="text-right text-slate-300">{ago(train.updatedAt, now)}</dd>
          {train.departureDate && (
            <>
              <dt className="text-slate-500">Avgångsdatum</dt>
              <dd className="text-right text-slate-300">{train.departureDate}</dd>
            </>
          )}
          <dt className="text-slate-500">Källa</dt>
          <dd className="text-right text-slate-300">{SOURCE[train.source]}</dd>
        </dl>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  color,
  icon,
}: {
  label: string;
  value: string;
  unit?: string | undefined;
  color?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg bg-white/5 px-2 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div
        className="mt-0.5 flex items-center justify-center gap-1 text-base font-semibold"
        style={{ color }}
      >
        {icon}
        <span className={cn(value.length > 8 && "text-sm")}>{value}</span>
      </div>
      {unit && <div className="text-[10px] text-slate-500">{unit}</div>}
    </div>
  );
}

function SpeedSparkline({ samples }: { samples: SpeedSample[] }) {
  if (samples.length < 2) {
    return <div className="py-4 text-center text-xs text-slate-500">Samlar data…</div>;
  }
  const w = 300;
  const h = 56;
  const t0 = samples[0]!.t;
  const t1 = samples.at(-1)!.t;
  const vMax = Math.max(60, ...samples.map((s) => s.v)) * 1.1;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * w;
  const y = (v: number) => h - (v / vMax) * h;
  const line = samples.map((s, i) => `${i ? "L" : "M"}${x(s.t).toFixed(1)},${y(s.v).toFixed(1)}`);
  const area = `${line.join(" ")} L${w},${h} L0,${h} Z`;
  const last = samples.at(-1)!;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-14 w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="speed-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#speed-fill)" />
      <path
        d={line.join(" ")}
        fill="none"
        stroke="#38bdf8"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={x(last.t)} cy={y(last.v)} r="3" fill="#38bdf8" />
    </svg>
  );
}
