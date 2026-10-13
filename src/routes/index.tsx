import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Box,
  Globe2,
  Layers,
  Mountain,
  Satellite,
  RotateCcw,
  Search,
  TrainFront,
  TrainTrack,
  TriangleAlert,
} from "lucide-react";
import maplibreCss from "maplibre-gl/dist/maplibre-gl.css?url";

import {
  TrainMap,
  type FollowMode,
  type MapController,
  type MapSettings,
} from "@/components/radar/TrainMap";
import { TrainPanel, type SpeedSample } from "@/components/radar/TrainPanel";
import { INITIAL_VIEW } from "@/components/radar/view";
import { useIsMobile } from "@/hooks/use-mobile";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DELAY_LEVELS, delayLevel, formatDelay, type DelayLevel } from "@/lib/trains/delay";
import type { LonLat } from "@/lib/trains/geo";
import type { Country, SourceStatus, Train, TrainsResponse } from "@/lib/trains/types";
import { cn } from "@/lib/utils";

const TITLE = "TrainRadar – tåg i realtid på 3D-karta";
const DESCRIPTION =
  "Följ alla tåg i Sverige och Finland live på en interaktiv 3D-karta: position, hastighet, förseningar och rutt.";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { train?: string } =>
    typeof search["train"] === "string" ? { train: search["train"] } : {},
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [{ rel: "stylesheet", href: maplibreCss }],
  }),
  component: Radar,
});

const REFRESH_MS = 10_000;
const TRAIL_POINTS = 180;
const SPEED_POINTS = 90;
const HISTORY_TTL_MS = 15 * 60 * 1000;

const COUNTRIES: { id: Country; label: string; flag: string }[] = [
  { id: "SE", label: "Sverige", flag: "🇸🇪" },
  { id: "FI", label: "Finland", flag: "🇫🇮" },
];
const LEVEL_ORDER: DelayLevel[] = ["onTime", "minor", "moderate", "major", "unknown"];

type History = { trail: LonLat[]; speed: SpeedSample[]; lastSeen: number };

async function fetchTrains(): Promise<TrainsResponse> {
  const res = await fetch("/api/trains");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as TrainsResponse;
}

function Radar() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/" });
  const selectedId = search.train ?? null;
  const setSelectedId = (id: string | null) => {
    void navigate({ search: id ? { train: id } : {}, replace: true });
  };

  const { data, isPending, isError } = useQuery({
    queryKey: ["trains"],
    queryFn: fetchTrains,
    refetchInterval: REFRESH_MS,
  });

  const [countries, setCountries] = useState<Set<Country>>(() => new Set(["SE", "FI"]));
  const [levels, setLevels] = useState<Set<DelayLevel>>(() => new Set(LEVEL_ORDER));
  const [settings, setSettings] = useState<MapSettings>({
    terrain: true,
    buildings: true,
    globe: true,
    satellite: true,
    railLines: true,
  });
  const [pitched, setPitched] = useState(INITIAL_VIEW.pitch > 0);
  const [follow, setFollow] = useState<FollowMode>("off");
  const controllerRef = useRef<MapController | null>(null);
  const isMobile = useIsMobile();

  // --- per-train history (trail + speed graph), collected while the page is open
  const historyRef = useRef(new Map<string, History>());
  const [historyVersion, setHistoryVersion] = useState(0);
  useEffect(() => {
    if (!data) return;
    const now = Date.parse(data.generatedAt);
    const history = historyRef.current;
    for (const t of data.trains) {
      const h = history.get(t.id) ?? { trail: [], speed: [], lastSeen: now };
      const last = h.trail.at(-1);
      if (!last || last[0] !== t.lon || last[1] !== t.lat) {
        h.trail.push([t.lon, t.lat]);
        if (h.trail.length > TRAIL_POINTS) h.trail.shift();
      }
      if (t.speed !== null && h.speed.at(-1)?.t !== now) {
        h.speed.push({ t: now, v: t.speed });
        if (h.speed.length > SPEED_POINTS) h.speed.shift();
      }
      h.lastSeen = now;
      history.set(t.id, h);
    }
    for (const [id, h] of history) if (now - h.lastSeen > HISTORY_TTL_MS) history.delete(id);
    setHistoryVersion((v) => v + 1);
  }, [data]);

  const allTrains = useMemo(() => data?.trains ?? [], [data]);
  const byId = useMemo(() => new Map(allTrains.map((t) => [t.id, t])), [allTrains]);
  const visibleTrains = useMemo(
    () =>
      allTrains.filter(
        (t) =>
          (countries.has(t.country) && levels.has(delayLevel(t.delayMin))) || t.id === selectedId,
      ),
    [allTrains, countries, levels, selectedId],
  );

  // Keep showing the last known state of a selected train that drops out of the feed.
  const lastSelectedRef = useRef<Train | null>(null);
  const liveSelected = selectedId ? byId.get(selectedId) : undefined;
  if (liveSelected) lastSelectedRef.current = liveSelected;
  const selected =
    liveSelected ?? (lastSelectedRef.current?.id === selectedId ? lastSelectedRef.current : null);

  const trail = useMemo(
    () => (selectedId ? [...(historyRef.current.get(selectedId)?.trail ?? [])] : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedId, historyVersion],
  );
  const speedHistory = useMemo(
    () => (selectedId ? [...(historyRef.current.get(selectedId)?.speed ?? [])] : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedId, historyVersion],
  );

  const hasPanel = selected !== null;
  const mapPadding = useMemo(
    () => ({
      right: hasPanel && !isMobile ? 420 : 0,
      bottom: hasPanel && isMobile ? Math.round(window.innerHeight * 0.45) : 0,
    }),
    [hasPanel, isMobile],
  );

  // Deep link: fly to ?train=… once it shows up.
  const flownToRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || flownToRef.current === selectedId || !byId.has(selectedId)) return;
    flownToRef.current = selectedId;
    // Wait a frame so the map has the train in its animation state.
    requestAnimationFrame(() => controllerRef.current?.flyToTrain(selectedId));
  }, [selectedId, byId]);

  const select = (id: string | null, fly = false) => {
    setFollow("off");
    flownToRef.current = id;
    setSelectedId(id);
    if (id && fly) requestAnimationFrame(() => controllerRef.current?.flyToTrain(id));
  };

  const setFollowMode = (mode: FollowMode) => {
    setFollow(mode);
    if (mode !== "off" && selectedId) {
      controllerRef.current?.flyToTrain(selectedId, { chase: mode === "chase" });
      if (mode === "chase") setPitched(true);
    }
  };

  // Keyboard: Esc deselects, "/" focuses search.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement;
      if (e.key === "Escape") {
        if (typing) (e.target as HTMLInputElement).blur();
        else select(null);
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toggle = <T,>(set: Set<T>, value: T) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  return (
    <TooltipProvider delayDuration={200}>
      <main className="dark relative h-dvh w-full overflow-hidden bg-[#0b1222] text-slate-100">
        <TrainMap
          trains={visibleTrains}
          selectedId={selectedId}
          onSelect={(id) => select(id)}
          follow={follow}
          onFollowEnd={() => setFollow("off")}
          trail={trail}
          settings={settings}
          controllerRef={controllerRef}
          padding={mapPadding}
        />

        {/* Top-left: brand, search, stats */}
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex w-[calc(100%-1.5rem)] max-w-[340px] flex-col gap-2">
          <div className="pointer-events-auto rounded-xl border border-white/10 bg-slate-950/85 p-3 shadow-2xl backdrop-blur-md">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-400 text-slate-950">
                <TrainFront className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <div className="font-bold leading-tight tracking-tight">TrainRadar</div>
                <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      isError ? "bg-red-500" : "animate-pulse bg-emerald-400",
                    )}
                  />
                  {isPending
                    ? "Ansluter…"
                    : `${visibleTrains.length} tåg live${
                        visibleTrains.length !== allTrains.length ? ` av ${allTrains.length}` : ""
                      }`}
                </div>
              </div>
              <SourceBadges sources={data?.sources ?? []} />
            </div>
            <SearchBox inputRef={searchRef} trains={allTrains} onPick={(id) => select(id, true)} />
          </div>

          <div className={cn("hidden", !selected && "md:block")}>
            <StatsCard trains={visibleTrains} onPick={(id) => select(id, true)} />
          </div>
        </div>

        {/* Top-right: map controls */}
        <div className="absolute right-3 top-3 z-10 hidden flex-col gap-2 md:flex">
          <MapControls
            settings={settings}
            onSettings={setSettings}
            pitched={pitched}
            onPitched={(p) => {
              setPitched(p);
              controllerRef.current?.setPitched(p);
            }}
            onReset={() => {
              setFollow("off");
              controllerRef.current?.resetView();
              setPitched(true);
            }}
          />
        </div>

        {/* Selected train panel */}
        {selected && (
          <div className="pointer-events-none absolute inset-x-2 bottom-2 z-20 max-h-[45dvh] md:inset-x-auto md:bottom-auto md:right-16 md:top-3 md:max-h-[calc(100dvh-1.5rem)] md:w-[360px]">
            <TrainPanel
              train={selected}
              stale={!liveSelected}
              speedHistory={speedHistory}
              follow={follow}
              onFollow={setFollowMode}
              onZoom={() => selectedId && controllerRef.current?.flyToTrain(selectedId)}
              onClose={() => select(null)}
            />
          </div>
        )}

        {/* Bottom-left: interactive legend / filters */}
        <div
          className={cn(
            "pointer-events-auto absolute bottom-3 left-3 z-10 max-w-[calc(100%-1.5rem)] rounded-xl border border-white/10 bg-slate-950/85 p-2 shadow-2xl backdrop-blur-md",
            selected && "hidden md:block",
          )}
        >
          <div className="flex flex-wrap items-center gap-1">
            {COUNTRIES.map((c) => (
              <Chip
                key={c.id}
                active={countries.has(c.id)}
                onClick={() => setCountries((s) => toggle(s, c.id))}
              >
                <span>{c.flag}</span>
                <span className="hidden sm:inline">{c.label}</span>
              </Chip>
            ))}
            <span className="mx-1 h-4 w-px bg-white/10" />
            {LEVEL_ORDER.map((level) => (
              <Chip
                key={level}
                active={levels.has(level)}
                onClick={() => setLevels((s) => toggle(s, level))}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: DELAY_LEVELS[level].color }}
                />
                <span className="text-[11px]">{DELAY_LEVELS[level].label}</span>
              </Chip>
            ))}
          </div>
        </div>

        {/* Loading / error states */}
        {isPending && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
            <div className="flex items-center gap-3 rounded-full border border-white/10 bg-slate-950/85 px-5 py-2.5 text-sm backdrop-blur-md">
              <TrainTrack className="h-4 w-4 animate-pulse text-amber-400" /> Hämtar tåg i realtid…
            </div>
          </div>
        )}
        {data && allTrains.length === 0 && (
          <div className="absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-full border border-amber-500/30 bg-slate-950/90 px-4 py-2 text-xs text-amber-200 backdrop-blur-md">
            <TriangleAlert className="mr-1.5 inline h-3.5 w-3.5" />
            Inga tåg från källorna just nu – försöker igen var {REFRESH_MS / 1000}:e sekund.
          </div>
        )}
      </main>
    </TooltipProvider>
  );
}

// --- pieces ------------------------------------------------------------------

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition",
        active
          ? "bg-white/10 text-slate-100"
          : "text-slate-500 line-through opacity-60 hover:opacity-100",
      )}
    >
      {children}
    </button>
  );
}

function SourceBadges({ sources }: { sources: SourceStatus[] }) {
  const flag: Record<Country, string> = { SE: "🇸🇪", FI: "🇫🇮" };
  return (
    <div className="flex gap-1">
      {sources.map((s) => (
        <Tooltip key={s.id}>
          <TooltipTrigger asChild>
            <span className="relative cursor-default text-base leading-none">
              {flag[s.country]}
              <span
                className={cn(
                  "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-slate-950",
                  s.ok ? "bg-emerald-400" : s.configured ? "bg-red-500" : "bg-amber-400",
                )}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[260px]">
            <div className="font-semibold capitalize">{s.id}</div>
            {s.ok ? `${s.count} tåg` : (s.error ?? "Fel")}
            {!s.configured && s.id === "trafikverket" && (
              <div className="mt-1 opacity-80">Sätt TRAFIKVERKET_API_KEY för svenska tåg.</div>
            )}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function SearchBox({
  trains,
  onPick,
  inputRef,
}: {
  trains: Train[];
  onPick: (id: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return trains
      .filter((t) =>
        [t.trainNo, t.operator, t.product, t.destination, t.nextStation]
          .filter(Boolean)
          .some((f) => f!.toLowerCase().includes(q)),
      )
      .slice(0, 8);
  }, [query, trains]);

  return (
    <div className="relative mt-3">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && results[0]) {
            onPick(results[0].id);
            setOpen(false);
            e.currentTarget.blur();
          }
        }}
        placeholder="Sök tågnummer, operatör, station…  ( / )"
        className="h-9 w-full rounded-lg border border-white/10 bg-white/5 pl-8 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
      />
      {open && results.length > 0 && (
        <ul className="absolute inset-x-0 top-10 z-30 overflow-hidden rounded-lg border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur-md">
          {results.map((t) => (
            <li key={t.id}>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick(t.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/10"
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: DELAY_LEVELS[delayLevel(t.delayMin)].color }}
                />
                <span className="font-medium">{t.trainNo}</span>
                <span className="truncate text-xs text-slate-400">
                  {t.operator}
                  {t.destination ? ` → ${t.destination}` : ""}
                </span>
                <span className="ml-auto shrink-0 text-xs text-slate-400">
                  {formatDelay(t.delayMin)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatsCard({ trains, onPick }: { trains: Train[]; onPick: (id: string) => void }) {
  const stats = useMemo(() => {
    const known = trains.filter((t) => t.delayMin !== null);
    const onTime = known.filter((t) => (t.delayMin ?? 0) <= 5).length;
    const avg = known.length
      ? known.reduce((s, t) => s + (t.delayMin ?? 0), 0) / known.length
      : null;
    const moving = trains.filter((t) => (t.speed ?? 0) > 5);
    const fastest = trains.reduce<Train | null>(
      (best, t) => ((t.speed ?? -1) > (best?.speed ?? -1) ? t : best),
      null,
    );
    const mostDelayed = [...known]
      .sort((a, b) => (b.delayMin ?? 0) - (a.delayMin ?? 0))
      .filter((t) => (t.delayMin ?? 0) > 2)
      .slice(0, 5);
    return {
      punctuality: known.length ? Math.round((onTime / known.length) * 100) : null,
      avg,
      moving: moving.length,
      fastest,
      mostDelayed,
    };
  }, [trains]);

  return (
    <div className="pointer-events-auto rounded-xl border border-white/10 bg-slate-950/85 p-3 shadow-2xl backdrop-blur-md">
      <div className="grid grid-cols-3 gap-2 text-center">
        <MiniStat
          label="Punktlighet"
          value={stats.punctuality !== null ? `${stats.punctuality}%` : "—"}
          hint="Andel tåg ≤ 5 min sena"
        />
        <MiniStat
          label="Snittförsening"
          value={stats.avg !== null ? `${stats.avg.toFixed(1)} min` : "—"}
        />
        <MiniStat label="I rörelse" value={String(stats.moving)} />
      </div>

      {stats.fastest && stats.fastest.speed !== null && (
        <button
          onClick={() => onPick(stats.fastest!.id)}
          className="mt-3 flex w-full items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-left text-xs hover:bg-white/10"
        >
          <span className="text-slate-400">Snabbast just nu</span>
          <span className="font-medium">
            {stats.fastest.trainNo} · {Math.round(stats.fastest.speed)} km/h
          </span>
        </button>
      )}

      {stats.mostDelayed.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
            Mest försenade
          </div>
          <ul className="space-y-0.5">
            {stats.mostDelayed.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => onPick(t.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-white/10"
                >
                  <span className="font-medium">{t.trainNo}</span>
                  <span className="truncate text-slate-400">{t.destination ?? t.operator}</span>
                  <span
                    className="ml-auto shrink-0 font-semibold"
                    style={{ color: DELAY_LEVELS[delayLevel(t.delayMin)].color }}
                  >
                    {formatDelay(t.delayMin)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-white/5 px-1 py-2" title={hint}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}

function MapControls({
  settings,
  onSettings,
  pitched,
  onPitched,
  onReset,
}: {
  settings: MapSettings;
  onSettings: (s: MapSettings) => void;
  pitched: boolean;
  onPitched: (p: boolean) => void;
  onReset: () => void;
}) {
  const layerRows: { key: keyof MapSettings; label: string; icon: React.ReactNode }[] = [
    { key: "terrain", label: "Terräng", icon: <Mountain className="h-4 w-4" /> },
    { key: "buildings", label: "3D-byggnader", icon: <Box className="h-4 w-4" /> },
    { key: "railLines", label: "Järnvägsnät", icon: <TrainTrack className="h-4 w-4" /> },
    { key: "satellite", label: "Satellit", icon: <Satellite className="h-4 w-4" /> },
    { key: "globe", label: "Jordglob", icon: <Globe2 className="h-4 w-4" /> },
  ];
  const btn =
    "flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-slate-950/85 text-slate-200 shadow-xl backdrop-blur-md hover:bg-slate-800";

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => onSettings({ ...settings, satellite: !settings.satellite })}
            className={cn(btn, settings.satellite && "border-sky-400/60 text-sky-300")}
            aria-label="Satellitbild"
            aria-pressed={settings.satellite}
          >
            <Satellite className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">
          {settings.satellite ? "Visa mörk karta" : "Visa satellitbild"}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button onClick={() => onPitched(!pitched)} className={cn(btn, "text-xs font-bold")}>
            {pitched ? "2D" : "3D"}
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">Växla {pitched ? "2D" : "3D"}-vy</TooltipContent>
      </Tooltip>
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button className={btn} aria-label="Kartlager">
                <Layers className="h-4 w-4" />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="left">Kartlager</TooltipContent>
        </Tooltip>
        <PopoverContent
          side="left"
          align="start"
          className="dark w-56 border-white/10 bg-slate-950/95 p-2 text-slate-100"
        >
          {layerRows.map((row) => (
            <label
              key={row.key}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-white/5"
            >
              {row.icon}
              <span className="flex-1">{row.label}</span>
              <Switch
                checked={settings[row.key]}
                onCheckedChange={(v) => onSettings({ ...settings, [row.key]: v })}
              />
            </label>
          ))}
        </PopoverContent>
      </Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <button onClick={onReset} className={btn} aria-label="Återställ vy">
            <RotateCcw className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">Återställ vy</TooltipContent>
      </Tooltip>
    </>
  );
}
