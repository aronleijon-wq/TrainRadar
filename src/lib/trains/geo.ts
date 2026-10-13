/** Small geometry helpers for animating and drawing trains on the map. */

export type LonLat = [number, number];

const M_PER_DEG = 111_320;

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export function lerpLonLat(a: LonLat, b: LonLat, t: number): LonLat {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
}

/** Interpolate bearings along the shortest arc (350° → 10° goes through 0°). */
export function lerpBearing(a: number, b: number, t: number) {
  const diff = ((b - a + 540) % 360) - 180;
  return (a + diff * t + 360) % 360;
}

export function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/** Offset a point by metres east/north. */
export function offsetMetres([lon, lat]: LonLat, east: number, north: number): LonLat {
  return [lon + east / (M_PER_DEG * Math.cos((lat * Math.PI) / 180)), lat + north / M_PER_DEG];
}

/**
 * Footprint of a train body centred on `center`, pointing along `bearing`,
 * with a pointed nose. Returned as a closed GeoJSON polygon ring.
 */
export function trainFootprint(
  center: LonLat,
  bearing: number,
  lengthM = 260,
  widthM = 34,
): LonLat[] {
  const rad = (bearing * Math.PI) / 180;
  const f: LonLat = [Math.sin(rad), Math.cos(rad)]; // forward (east, north)
  const r: LonLat = [Math.cos(rad), -Math.sin(rad)]; // right
  const at = (along: number, across: number) =>
    offsetMetres(center, f[0] * along + r[0] * across, f[1] * along + r[1] * across);
  const half = lengthM / 2;
  const w = widthM / 2;
  const ring = [
    at(-half, -w),
    at(half - widthM, -w),
    at(half, 0),
    at(half - widthM, w),
    at(-half, w),
  ];
  return [...ring, ring[0]!];
}
