// Forex economic calendar — public JSON feed (best-effort CORS).

const CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

export async function fetchEconomicEvents() {
  try {
    const res = await fetch(CALENDAR_URL, { mode: "cors" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rows = await res.json();
    if (!Array.isArray(rows)) return { events: [], error: "bad_format" };
    const events = rows.slice(0, 40).map((e) => ({
      title: e.title,
      country: e.country,
      impact: e.impact,
      date: e.date,
      forecast: e.forecast,
      previous: e.previous,
    }));
    return { events };
  } catch (err) {
    return { events: [], error: err?.message || "calendar_unavailable" };
  }
}

export function eventsForDate(events, timestampSec) {
  const day = new Date(timestampSec * 1000).toISOString().slice(0, 10);
  return events.filter((e) => String(e.date || "").startsWith(day));
}
