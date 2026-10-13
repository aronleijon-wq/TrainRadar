import type { LonLat } from "@/lib/trains/geo";

/** Opening camera: Sweden + Finland, tilted for the 3D look. */
export const INITIAL_VIEW = {
  center: [19.5, 62.5] as LonLat,
  zoom: 4.3,
  pitch: 45,
  bearing: -12,
};
