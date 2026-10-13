export type DelayLevel = "unknown" | "onTime" | "minor" | "moderate" | "major";

export const DELAY_LEVELS: Record<DelayLevel, { label: string; color: string }> = {
  onTime: { label: "I tid (≤2 min)", color: "#22c55e" },
  minor: { label: "3–5 min", color: "#eab308" },
  moderate: { label: "6–15 min", color: "#f97316" },
  major: { label: "> 15 min", color: "#ef4444" },
  unknown: { label: "Okänd", color: "#94a3b8" },
};

export function delayLevel(delayMin: number | null): DelayLevel {
  if (delayMin === null) return "unknown";
  if (delayMin <= 2) return "onTime";
  if (delayMin <= 5) return "minor";
  if (delayMin <= 15) return "moderate";
  return "major";
}

export function formatDelay(delayMin: number | null): string {
  if (delayMin === null) return "Okänd";
  if (delayMin === 0) return "I tid";
  if (delayMin < 0) return `${-delayMin} min tidig`;
  return `+${delayMin} min`;
}
