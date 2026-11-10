// Text formatting helpers. Dates use the viewer's own time zone.

export function greeting(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function fullName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ");
}

const UNITS = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

// "3 days ago", "in 2 hours", "just now"
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return "";
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return "just now";
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (abs >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// "3:17 PM on January 19th 2026"
export function longDateTime(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const month = d.toLocaleDateString("en-US", { month: "long" });
  return `${time} on ${month} ${ordinal(d.getDate())} ${d.getFullYear()}`;
}

// "January 19th 2026"
export function longDate(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "long" })} ${ordinal(d.getDate())} ${d.getFullYear()}`;
}

export function fileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
