export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const base = 1024;
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(base)),
    units.length - 1
  );
  const value = bytes / Math.pow(base, exponent);

  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${
    units[exponent]
  }`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0s";
  }

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedSeconds = String(seconds).padStart(2, "0");

  if (hours > 0) {
    const paddedMinutes = String(minutes).padStart(2, "0");
    return `${hours}h ${paddedMinutes}m ${paddedSeconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${paddedSeconds}s`;
  }
  return `${seconds}s`;
}
