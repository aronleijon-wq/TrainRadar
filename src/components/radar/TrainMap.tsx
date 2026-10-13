import { useEffect, useRef } from "react";
import type {
  FilterSpecification,
  GeoJSONSource,
  Map as MlMap,
  MapGeoJSONFeature,
  Popup as MlPopup,
  SkySpecification,
} from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";

import { DELAY_LEVELS, delayLevel, formatDelay } from "@/lib/trains/delay";
import { easeInOut, lerpBearing, lerpLonLat, trainFootprint, type LonLat } from "@/lib/trains/geo";
import type { Train } from "@/lib/trains/types";

import { INITIAL_VIEW } from "./view";

/** Free, key-less map data. */
const BASE_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const OPENMAPTILES = "https://tiles.openfreemap.org/planet";
const SATELLITE_TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const TERRARIUM_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

const TWEEN_MS = 2500;
/** Jumps longer than this are teleports (new train, bad fix) — don't animate. */
const MAX_TWEEN_DEG = 0.3;

export type MapSettings = {
  terrain: boolean;
  buildings: boolean;
  globe: boolean;
  railLines: boolean;
  satellite: boolean;
};

export type FollowMode = "off" | "follow" | "chase";

export type MapController = {
  flyToTrain: (id: string, opts?: { chase?: boolean }) => void;
  resetView: () => void;
  setPitched: (pitched: boolean) => void;
};

type Props = {
  trains: Train[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  follow: FollowMode;
  onFollowEnd: () => void;
  trail: LonLat[];
  settings: MapSettings;
  controllerRef: React.MutableRefObject<MapController | null>;
  /** Screen space covered by overlays (e.g. the train panel), in px. */
  padding: { right: number; bottom: number };
};

type Anim = {
  train: Train;
  from: LonLat;
  to: LonLat;
  fromBearing: number | null;
  toBearing: number | null;
};

const TRAIN_LAYERS = ["train-icons", "train-bodies", "train-labels"];

export function TrainMap(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const readyRef = useRef(false);
  const propsRef = useRef(props);
  propsRef.current = props;

  const animRef = useRef(new Map<string, Anim>());
  const tweenStartRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  // --- animation ---------------------------------------------------------

  function progress() {
    return easeInOut(Math.min(1, (performance.now() - tweenStartRef.current) / TWEEN_MS));
  }

  function currentPose(a: Anim, t: number): { pos: LonLat; bearing: number | null } {
    const pos = lerpLonLat(a.from, a.to, t);
    if (a.fromBearing === null || a.toBearing === null) {
      return { pos, bearing: a.toBearing ?? a.fromBearing };
    }
    return { pos, bearing: lerpBearing(a.fromBearing, a.toBearing, t) };
  }

  function renderFrame() {
    const map = mapRef.current;
    if (!map || !readyRef.current) return 1;
    const t = progress();
    const { selectedId, follow, trail } = propsRef.current;

    const points: Feature[] = [];
    const bodies: Feature[] = [];
    let selectedPose: { pos: LonLat; bearing: number | null } | null = null;
    let selectedTarget: LonLat | null = null;

    for (const [id, a] of animRef.current) {
      const pose = currentPose(a, t);
      const level = delayLevel(a.train.delayMin);
      const color = DELAY_LEVELS[level].color;
      const selected = id === selectedId;
      if (selected) {
        selectedPose = pose;
        selectedTarget = a.to;
      }

      points.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: pose.pos },
        properties: {
          id,
          label: a.train.trainNo,
          icon: `train-${pose.bearing === null ? "dot" : "arrow"}-${level}`,
          bearing: pose.bearing ?? 0,
          selected,
          delay: formatDelay(a.train.delayMin),
          sort: selected ? 1 : 0,
        },
      });
      bodies.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [trainFootprint(pose.pos, pose.bearing ?? 0)] },
        properties: { id, color, selected },
      });
    }

    (map.getSource("trains") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: points,
    });
    (map.getSource("train-bodies") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: bodies,
    });

    // The newest fix is where the train is heading, not where it has been:
    // end the trail at the animated position instead.
    const last = trail.at(-1);
    const passed =
      last && selectedTarget && last[0] === selectedTarget[0] && last[1] === selectedTarget[1]
        ? trail.slice(0, -1)
        : trail;
    const trailCoords = selectedPose ? [...passed, selectedPose.pos] : [];
    (map.getSource("trail") as GeoJSONSource | undefined)?.setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: trailCoords.length > 1 ? trailCoords : [] },
      properties: {},
    });

    if (selectedPose && follow !== "off" && !map.isMoving()) {
      map.jumpTo({
        center: selectedPose.pos,
        ...(follow === "chase" && selectedPose.bearing !== null
          ? { bearing: selectedPose.bearing }
          : {}),
      });
    }
    return t;
  }

  function startLoop() {
    if (rafRef.current !== null) return;
    const tick = () => {
      const t = renderFrame();
      rafRef.current = t < 1 ? requestAnimationFrame(tick) : null;
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  // --- map setup -----------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    let map: MlMap | null = null;

    void (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      if (cancelled || !containerRef.current) return;

      map = new maplibregl.Map({
        container: containerRef.current,
        style: BASE_STYLE,
        center: INITIAL_VIEW.center,
        zoom: INITIAL_VIEW.zoom,
        pitch: INITIAL_VIEW.pitch,
        bearing: INITIAL_VIEW.bearing,
        maxPitch: 80,
        attributionControl: { compact: true },
      });
      mapRef.current = map;
      if (import.meta.env.DEV) Object.assign(window, { __trainMap: map });
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
      map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

      const popup: MlPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 14,
        className: "train-popup",
      });

      map.on("load", () => {
        if (!map) return;
        setupLayers(map);
        readyRef.current = true;
        applySettings(map, propsRef.current.settings);
        renderFrame();
      });

      // Stop following when the user grabs the map.
      map.on("dragstart", () => {
        if (propsRef.current.follow !== "off") propsRef.current.onFollowEnd();
      });

      const pick = (point: { x: number; y: number }): MapGeoJSONFeature | undefined => {
        if (!map) return undefined;
        const layers = TRAIN_LAYERS.filter((l) => map!.getLayer(l));
        const pad = 8;
        return map.queryRenderedFeatures(
          [
            [point.x - pad, point.y - pad],
            [point.x + pad, point.y + pad],
          ],
          { layers },
        )[0];
      };

      map.on("click", (e) => {
        const id = pick(e.point)?.properties?.["id"];
        propsRef.current.onSelect(typeof id === "string" ? id : null);
      });

      map.on("mousemove", (e) => {
        if (!map) return;
        const feature = pick(e.point);
        map.getCanvas().style.cursor = feature ? "pointer" : "";
        const id = feature?.properties?.["id"];
        const a = typeof id === "string" ? animRef.current.get(id) : undefined;
        if (!a) {
          popup.remove();
          return;
        }
        const t = a.train;
        const color = DELAY_LEVELS[delayLevel(t.delayMin)].color;
        popup
          .setLngLat(e.lngLat)
          .setHTML(
            `<div class="font-semibold">${escapeHtml(t.trainNo)}</div>` +
              `<div class="text-xs opacity-80">${escapeHtml(t.operator ?? "")}${
                t.destination ? ` → ${escapeHtml(t.destination)}` : ""
              }</div>` +
              `<div class="text-xs" style="color:${color}">${escapeHtml(formatDelay(t.delayMin))}${
                t.speed !== null ? ` · ${Math.round(t.speed)} km/h` : ""
              }</div>`,
          )
          .addTo(map);
      });
      map.on("mouseout", () => popup.remove());
    })();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      readyRef.current = false;
      map?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- data updates --------------------------------------------------------

  useEffect(() => {
    const t = progress();
    const next = new Map<string, Anim>();
    for (const train of props.trains) {
      const prev = animRef.current.get(train.id);
      const to: LonLat = [train.lon, train.lat];
      let from = to;
      let fromBearing = train.bearing;
      if (prev) {
        const pose = currentPose(prev, t);
        const far =
          Math.abs(pose.pos[0] - to[0]) > MAX_TWEEN_DEG ||
          Math.abs(pose.pos[1] - to[1]) > MAX_TWEEN_DEG;
        if (!far) from = pose.pos;
        fromBearing = pose.bearing ?? train.bearing;
      }
      next.set(train.id, { train, from, to, fromBearing, toBearing: train.bearing ?? fromBearing });
    }
    animRef.current = next;
    tweenStartRef.current = performance.now();
    startLoop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.trains]);

  // Selection, trail and follow changes need one redraw even if nothing moves.
  useEffect(() => {
    renderFrame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selectedId, props.trail, props.follow]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) applySettings(map, props.settings);
  }, [props.settings]);

  // Keep the camera centre clear of the info panel.
  const { right: padRight, bottom: padBottom } = props.padding;
  useEffect(() => {
    mapRef.current?.easeTo({
      padding: cameraPadding({ right: padRight, bottom: padBottom }),
      duration: 600,
    });
  }, [padRight, padBottom]);

  // --- imperative controller -------------------------------------------------

  useEffect(() => {
    props.controllerRef.current = {
      flyToTrain: (id, opts) => {
        const map = mapRef.current;
        const a = animRef.current.get(id);
        if (!map || !a) return;
        const pose = currentPose(a, progress());
        map.flyTo({
          center: pose.pos,
          zoom: opts?.chase ? 14.5 : Math.max(map.getZoom(), 10),
          pitch: opts?.chase ? 72 : Math.max(map.getPitch(), 50),
          bearing: opts?.chase && pose.bearing !== null ? pose.bearing : map.getBearing(),
          padding: cameraPadding(propsRef.current.padding),
          duration: 2200,
          essential: true,
        });
      },
      resetView: () => {
        mapRef.current?.flyTo({
          ...INITIAL_VIEW,
          padding: cameraPadding(propsRef.current.padding),
          duration: 2000,
          essential: true,
        });
      },
      setPitched: (pitched) => {
        mapRef.current?.easeTo({ pitch: pitched ? 60 : 0, duration: 800 });
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Inline style: maplibre-gl.css sets `.maplibregl-map { position: relative }`
  // unlayered, which would beat Tailwind's layered `absolute` utility.
  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
}

// --- layers ------------------------------------------------------------------

function firstSymbolLayer(map: MlMap): string | undefined {
  return map.getStyle().layers.find((l) => l.type === "symbol")?.id;
}

function baseFont(map: MlMap): string[] {
  for (const layer of map.getStyle().layers) {
    if (layer.type !== "symbol") continue;
    const font = layer.layout?.["text-font"];
    if (Array.isArray(font) && font.every((f) => typeof f === "string")) return font as string[];
  }
  return ["Open Sans Regular"];
}

function setupLayers(map: MlMap) {
  const beforeLabels = firstSymbolLayer(map);

  for (const [level, { color }] of Object.entries(DELAY_LEVELS)) {
    map.addImage(`train-arrow-${level}`, drawIcon("arrow", color), { pixelRatio: 2 });
    map.addImage(`train-dot-${level}`, drawIcon("dot", color), { pixelRatio: 2 });
  }

  map.setSky({
    "sky-color": "#0b1222",
    "horizon-color": "#1e2a44",
    "fog-color": "#0b1222",
    "sky-horizon-blend": 0.6,
    "horizon-fog-blend": 0.6,
    "fog-ground-blend": 0.7,
    "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 7, 0.4, 10, 0],
  } satisfies SkySpecification);

  // Terrain + hillshade (AWS open elevation tiles, terrarium encoding).
  const dem = {
    type: "raster-dem" as const,
    tiles: [TERRARIUM_TILES],
    encoding: "terrarium" as const,
    tileSize: 256,
    maxzoom: 13,
    attribution: "Terrain: Mapzen / AWS Open Data",
  };
  map.addSource("dem", dem);
  map.addSource("dem-hillshade", dem);

  // Real aerial imagery, drawn over the base map's land/water/roads but under labels.
  map.addSource("satellite", {
    type: "raster",
    tiles: [SATELLITE_TILES],
    tileSize: 256,
    maxzoom: 19,
    attribution: "Satellitbild: Esri, Maxar, Earthstar Geographics",
  });
  map.addLayer(
    {
      id: "satellite",
      type: "raster",
      source: "satellite",
      layout: { visibility: "none" },
      paint: { "raster-fade-duration": 200 },
    },
    beforeLabels,
  );
  map.addLayer(
    {
      id: "hillshade",
      type: "hillshade",
      source: "dem-hillshade",
      paint: {
        "hillshade-shadow-color": "#000000",
        "hillshade-highlight-color": "#3b4a6b",
        "hillshade-accent-color": "#0f172a",
        "hillshade-exaggeration": 0.35,
      },
    },
    beforeLabels,
  );

  // Railway network and 3D buildings from OpenMapTiles (OpenFreeMap).
  map.addSource("omt", { type: "vector", url: OPENMAPTILES });
  const railFilter: FilterSpecification = [
    "in",
    ["get", "class"],
    ["literal", ["rail", "transit"]],
  ];
  map.addLayer(
    {
      id: "rail-glow",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      filter: railFilter,
      paint: {
        "line-color": "#f59e0b",
        "line-opacity": 0.18,
        "line-blur": 3,
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2, 10, 5, 15, 10],
      },
    },
    beforeLabels,
  );
  map.addLayer(
    {
      id: "rail-lines",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      filter: railFilter,
      paint: {
        "line-color": "#fbbf24",
        "line-opacity": 0.55,
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.4, 10, 1.2, 15, 2.5],
      },
    },
    beforeLabels,
  );
  map.addLayer(
    {
      id: "buildings-3d",
      type: "fill-extrusion",
      source: "omt",
      "source-layer": "building",
      minzoom: 13,
      paint: {
        "fill-extrusion-color": "#1e293b",
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 14, 0.85],
      },
    },
    beforeLabels,
  );

  // Trains.
  map.addSource("trail", {
    type: "geojson",
    lineMetrics: true,
    data: { type: "Feature", geometry: { type: "LineString", coordinates: [] }, properties: {} },
  });
  map.addSource("train-bodies", { type: "geojson", data: emptyCollection() });
  map.addSource("trains", { type: "geojson", data: emptyCollection() });

  map.addLayer({
    id: "train-trail",
    type: "line",
    source: "trail",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-width": ["interpolate", ["linear"], ["zoom"], 5, 2, 14, 6],
      "line-gradient": [
        "interpolate",
        ["linear"],
        ["line-progress"],
        0,
        "rgba(56,189,248,0)",
        1,
        "rgba(56,189,248,0.95)",
      ],
    },
  });
  map.addLayer({
    id: "train-bodies",
    type: "fill-extrusion",
    source: "train-bodies",
    minzoom: 11,
    paint: {
      "fill-extrusion-color": ["case", ["get", "selected"], "#ffffff", ["get", "color"]],
      "fill-extrusion-height": 22,
      "fill-extrusion-base": 4,
      "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0, 12.5, 0.95],
    },
  });
  map.addLayer({
    id: "train-halo",
    type: "circle",
    source: "trains",
    filter: ["==", ["get", "selected"], true],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 12, 12, 22],
      "circle-color": "rgba(56,189,248,0.15)",
      "circle-stroke-color": "#38bdf8",
      "circle-stroke-width": 2,
      "circle-pitch-alignment": "map",
    },
  });
  map.addLayer({
    id: "train-icons",
    type: "symbol",
    source: "trains",
    layout: {
      "icon-image": ["get", "icon"],
      "icon-rotate": ["get", "bearing"],
      "icon-rotation-alignment": "map",
      "icon-pitch-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.45, 8, 0.75, 12, 1],
      "symbol-sort-key": ["get", "sort"],
    },
    paint: {
      "icon-opacity": ["interpolate", ["linear"], ["zoom"], 12, 1, 13.5, 0.25],
    },
  });
  map.addLayer({
    id: "train-labels",
    type: "symbol",
    source: "trains",
    minzoom: 7,
    layout: {
      "text-field": ["get", "label"],
      "text-font": baseFont(map),
      "text-size": 11,
      "text-offset": [0, 1.3],
      "text-anchor": "top",
      "text-optional": true,
    },
    paint: {
      "text-color": "#e2e8f0",
      "text-halo-color": "#0b1222",
      "text-halo-width": 1.5,
    },
  });
}

function applySettings(map: MlMap, settings: MapSettings) {
  const vis = (on: boolean) => (on ? "visible" : "none");
  if (map.getLayer("satellite"))
    map.setLayoutProperty("satellite", "visibility", vis(settings.satellite));
  if (map.getLayer("hillshade"))
    map.setLayoutProperty("hillshade", "visibility", vis(settings.terrain));
  if (map.getLayer("buildings-3d")) {
    map.setLayoutProperty("buildings-3d", "visibility", vis(settings.buildings));
  }
  for (const id of ["rail-glow", "rail-lines"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis(settings.railLines));
  }
  map.setTerrain(settings.terrain ? { source: "dem", exaggeration: 1.6 } : null);
  map.setProjection({ type: settings.globe ? "globe" : "mercator" });
}

function cameraPadding(p: { right: number; bottom: number }) {
  return { top: 0, left: 0, right: p.right, bottom: p.bottom };
}

function emptyCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

/** Draws a train marker: a pointed "bullet train" seen from above, or a dot. */
function drawIcon(shape: "arrow" | "dot", color: string): ImageData {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.strokeStyle = "#0b1222";
  ctx.lineWidth = 4;
  ctx.beginPath();
  if (shape === "arrow") {
    const cx = size / 2;
    ctx.moveTo(cx, 4);
    ctx.bezierCurveTo(cx + 16, 16, cx + 14, 26, cx + 14, 30);
    ctx.lineTo(cx + 14, 58);
    ctx.quadraticCurveTo(cx + 14, 61, cx + 10, 61);
    ctx.lineTo(cx - 10, 61);
    ctx.quadraticCurveTo(cx - 14, 61, cx - 14, 58);
    ctx.lineTo(cx - 14, 30);
    ctx.bezierCurveTo(cx - 14, 26, cx - 16, 16, cx, 4);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    // windscreen
    ctx.fillStyle = "rgba(11,18,34,0.55)";
    ctx.beginPath();
    ctx.moveTo(cx, 12);
    ctx.bezierCurveTo(cx + 9, 19, cx + 9, 24, cx + 8, 26);
    ctx.lineTo(cx - 8, 26);
    ctx.bezierCurveTo(cx - 9, 24, cx - 9, 19, cx, 12);
    ctx.fill();
  } else {
    ctx.arc(size / 2, size / 2, 15, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fill();
  }
  return ctx.getImageData(0, 0, size, size);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
