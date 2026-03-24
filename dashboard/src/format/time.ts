export function timeAgo(iso: string | undefined): string {
  if (iso == null || iso === "") return "\u2014";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
  if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
  return Math.floor(diff / 86400000) + "d ago";
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60000) return Math.floor(ms / 1000) + "s";
  if (ms < 3600000)
    return (
      Math.floor(ms / 60000) +
      "m " +
      Math.floor((ms % 60000) / 1000) +
      "s"
    );
  return (
    Math.floor(ms / 3600000) +
    "h " +
    Math.floor((ms % 3600000) / 60000) +
    "m"
  );
}
