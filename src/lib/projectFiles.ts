/** Short badge text for a delivered file, from its name. */
export function fileBadge(name: string, clipId: string): string {
  const rest = name.startsWith(clipId) ? name.slice(clipId.length) : name;
  const map: Record<string, string> = {
    ".mp4": "MP4 L",
    "_right.mp4": "MP4 R",
    ".mcap": "MCAP",
    "_frames.csv": "FRAMES",
    "_imu.csv": "IMU",
    "_calibration.json": "CALIB",
    ".json": "SIDECAR",
    SHA256SUMS: "SHA256",
    "recording.svo2": "SVO2",
    "audio.flac": "AUDIO",
    "audio.json": "AUDIO META",
    "metadata.json": "META",
  };
  return map[rest] ?? rest.replace(/^[_.]/, "").toUpperCase();
}

const BADGE_ORDER = ["MP4 L", "MP4 R", "MCAP", "SVO2", "SIDECAR", "META", "CALIB", "FRAMES", "IMU", "AUDIO", "AUDIO META", "SHA256"];

export function badgeRank(label: string): number {
  const i = BADGE_ORDER.indexOf(label);
  return i < 0 ? BADGE_ORDER.length : i;
}
