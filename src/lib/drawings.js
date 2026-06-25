// Chart drawing system: pure data + geometry helpers.
// Nothing in this file touches React or the DOM — it only knows about
// chart coordinate mapping (via the lightweight-charts chart/series handles
// passed in) and plain drawing objects. Keeping this framework-agnostic
// makes the math easy to reason about and keeps ChartDrawingLayer.jsx thin.

import { formatPrice } from "./priceFormat.js";

// ---------------------------------------------------------------------------
// Tool catalogue
// ---------------------------------------------------------------------------

export const DRAWING_TOOLS = [
  { id: "select", icon: "cursor", label: "Cross / select" },
  { id: "trendline", icon: "trendline", label: "Trend line" },
  { id: "ray", icon: "ray", label: "Ray" },
  { id: "horizontal", icon: "horizontal", label: "Horizontal line" },
  { id: "vertical", icon: "vertical", label: "Vertical line" },
  { id: "arrow", icon: "arrow", label: "Arrow" },
  { id: "rectangle", icon: "rectangle", label: "Rectangle" },
  { id: "fib", icon: "fib", label: "Fib retracement" },
  { id: "text", icon: "text", label: "Text note" },
  { id: "measure", icon: "measure", label: "Measure" },
  { id: "long-position", icon: "long", label: "Long position" },
  { id: "short-position", icon: "short", label: "Short position" },
  { id: "risk-reward", icon: "rr", label: "Risk / reward box" },
];

export const DRAWING_TOOL_GROUPS = [
  { id: "select", label: "Select", tools: ["select"] },
  { id: "lines", label: "Lines", tools: ["trendline", "ray", "horizontal", "vertical", "arrow"] },
  { id: "shapes", label: "Shapes", tools: ["rectangle", "fib", "text"] },
  { id: "measure", label: "Measure", tools: ["measure"] },
  { id: "positions", label: "Positions", tools: ["long-position", "short-position", "risk-reward"] },
];

// Tools that commit on a single click.
export const SINGLE_POINT_TOOLS = new Set(["horizontal", "vertical", "text"]);
// Tools that need two clicks (or one drag) and show a live rubber-band
// preview between point one and the current cursor position.
export const TWO_POINT_TOOLS = new Set([
  "trendline",
  "ray",
  "arrow",
  "rectangle",
  "fib",
  "measure",
  "long-position",
  "short-position",
  "risk-reward",
]);

export const LINE_STYLES = {
  solid: { label: "Solid", dash: undefined },
  dashed: { label: "Dashed", dash: "8 6" },
  dotted: { label: "Dotted", dash: "1.5 5" },
};

export function toolLabel(type) {
  return DRAWING_TOOLS.find((tool) => tool.id === type)?.label || type;
}

// ---------------------------------------------------------------------------
// Anchors: every drawing point is stored as { time, price } — chart-data
// coordinates, never raw pixels. `time` is a unix-seconds value (matching
// lightweight-charts' UTCTimestamp), `price` is in the series' native units.
// ---------------------------------------------------------------------------

/** Read the data-space anchor under a pixel position, or null if the chart isn't ready / point is off-scale. */
export function anchorFromPixel(x, y, chart, series) {
  if (!chart || !series) return null;
  const time = chart.timeScale().coordinateToTime(x);
  const price = series.coordinateToPrice(y);
  if (time == null || !Number.isFinite(price)) return null;
  return { time: normalizeTime(time), price };
}

function normalizeTime(value) {
  if (Number.isFinite(value)) return Number(value);
  if (value && Number.isFinite(value.timestamp)) return Number(value.timestamp);
  return null;
}

/** Project a data-space anchor back to pixel space. Returns null if off-scale (chart panned away from it). */
export function anchorToPixel(anchor, chart, series) {
  if (!anchor || !chart || !series) return null;
  const x = chart.timeScale().timeToCoordinate(anchor.time);
  const y = series.priceToCoordinate(anchor.price);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** Snap an anchor to the OHLC point of the nearest candle (magnet mode). */
export function snapAnchorToOhlc(anchor, candles) {
  if (!candles?.length || !anchor) return anchor;
  let nearest = candles[0];
  let bestDelta = Math.abs(nearest.time - anchor.time);
  for (const candle of candles) {
    const delta = Math.abs(candle.time - anchor.time);
    if (delta < bestDelta) {
      bestDelta = delta;
      nearest = candle;
    }
  }
  const candidates = [nearest.open, nearest.high, nearest.low, nearest.close].filter(Number.isFinite);
  if (!candidates.length) return { time: nearest.time, price: anchor.price };
  const price = candidates.reduce((best, value) =>
    Math.abs(value - anchor.price) < Math.abs(best - anchor.price) ? value : best, candidates[0]);
  return { time: nearest.time, price };
}

// ---------------------------------------------------------------------------
// Drawing factory + per-context compatibility
// ---------------------------------------------------------------------------

export function makeDrawingId(type) {
  return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeDrawing(type, p1, p2, style, context) {
  return {
    id: makeDrawingId(type),
    version: 2,
    type,
    context, // { exchange, market, symbol, timeframe } — anchors the drawing to a chart identity
    p1,
    p2: p2 || p1,
    color: style.color,
    width: clampWidth(style.width),
    lineStyle: style.lineStyle || "solid",
    visible: true,
    locked: false,
    text: type === "text" ? "Note" : undefined,
    createdAt: new Date().toISOString(),
  };
}

export function clampWidth(value) {
  const n = Math.round(Number(value));
  return Math.min(6, Math.max(1, Number.isFinite(n) ? n : 2));
}

/**
 * Whether a saved drawing still belongs on the chart currently showing.
 * - "active": exact exchange + market + symbol + timeframe match.
 * - "partial": same instrument, different timeframe — geometry may still be
 *    meaningful (e.g. a horizontal support level) but a trendline's slope
 *    was fit to a different bar spacing, so we mark it rather than pretend
 *    it's exact.
 * - "inactive": different instrument entirely, or pre-context legacy data.
 */
export function drawingCompatibility(drawing, context) {
  const saved = drawing.context;
  if (!saved || !saved.exchange || !saved.symbol) {
    return { status: "inactive", message: "No chart context saved with this drawing" };
  }
  if (saved.exchange !== context.exchange || saved.market !== context.market || saved.symbol !== context.symbol) {
    return { status: "inactive", message: `Belongs to ${saved.symbol || "?"} (${saved.market || "?"})` };
  }
  if (saved.timeframe !== context.timeframe) {
    return { status: "partial", message: `Saved on ${saved.timeframe} timeframe` };
  }
  return { status: "active", message: "" };
}

// ---------------------------------------------------------------------------
// Geometry: dragging, resizing, hit-testing
// ---------------------------------------------------------------------------

/** Apply a drag operation (move whole shape, or move a single handle) to produce a new drawing. */
export function applyDrag(drawing, dragMode, startAnchor, currentAnchor, originalDrawing) {
  if (dragMode === "p1") return { ...drawing, p1: currentAnchor };
  if (dragMode === "p2") return { ...drawing, p2: currentAnchor };
  // Box corners: "corner-tr" carries p2's time with p1's price; "corner-bl"
  // carries p1's time with p2's price. Dragging either lets you resize a
  // rectangle/position box from any of its four corners, not just its two
  // stored anchors.
  if (dragMode === "corner-tr") {
    return { ...drawing, p1: { ...drawing.p1, price: currentAnchor.price }, p2: { ...drawing.p2, time: currentAnchor.time } };
  }
  if (dragMode === "corner-bl") {
    return { ...drawing, p1: { ...drawing.p1, time: currentAnchor.time }, p2: { ...drawing.p2, price: currentAnchor.price } };
  }
  // Whole-shape move: translate both points by the same delta.
  const deltaTime = currentAnchor.time - startAnchor.time;
  const deltaPrice = currentAnchor.price - startAnchor.price;
  const translate = (point) => ({ time: point.time + deltaTime, price: point.price + deltaPrice });
  return { ...drawing, p1: translate(originalDrawing.p1), p2: translate(originalDrawing.p2 || originalDrawing.p1) };
}

const HANDLE_HIT_RADIUS = 7;
const LINE_HIT_TOLERANCE = 6;

/**
 * Hit-test a pixel point against all projected drawings (topmost first).
 * Returns { id, handle } where handle is one of:
 *   "p1" | "p2"                       — endpoint drag (lines, rays, arrows, fib, measure, box corners)
 *   "corner-tr" | "corner-bl"         — the other two corners of a box tool
 *   undefined                          — whole-shape move
 */
export function hitTestDrawings(drawings, point, chart, series, chartWidth) {
  for (const drawing of [...drawings].reverse()) {
    if (drawing.visible === false || drawing.locked) continue;
    const hit = hitTestOne(drawing, point, chart, series, chartWidth);
    if (hit) return hit;
  }
  return null;
}

/** Like hitTestDrawings but also returns locked shapes (for hover/cursor feedback only — never for dragging). */
export function hitTestAny(drawings, point, chart, series, chartWidth) {
  for (const drawing of [...drawings].reverse()) {
    if (drawing.visible === false) continue;
    const hit = hitTestOne(drawing, point, chart, series, chartWidth);
    if (hit) return { ...hit, locked: !!drawing.locked };
  }
  return null;
}

function hitTestOne(drawing, point, chart, series, chartWidth) {
  const p1 = anchorToPixel(drawing.p1, chart, series);
  const p2 = anchorToPixel(drawing.p2 || drawing.p1, chart, series);
  if (!p1 || !p2) return null;

  if (isBoxTool(drawing.type)) {
    // Four corners: p1 (time1,price1), p2 (time2,price2), and the two mixed
    // corners which drag a single axis of p1 or p2 — this is what makes a
    // rectangle resizable from any corner, not just its own two anchors.
    const cornerTR = { x: p2.x, y: p1.y }; // time2, price1
    const cornerBL = { x: p1.x, y: p2.y }; // time1, price2
    if (dist(point, p1) < HANDLE_HIT_RADIUS) return { id: drawing.id, handle: "p1" };
    if (dist(point, p2) < HANDLE_HIT_RADIUS) return { id: drawing.id, handle: "p2" };
    if (dist(point, cornerTR) < HANDLE_HIT_RADIUS) return { id: drawing.id, handle: "corner-tr" };
    if (dist(point, cornerBL) < HANDLE_HIT_RADIUS) return { id: drawing.id, handle: "corner-bl" };
    const box = rectFromPoints(p1, p2);
    const within =
      point.x >= box.x - LINE_HIT_TOLERANCE &&
      point.x <= box.x + box.width + LINE_HIT_TOLERANCE &&
      point.y >= box.y - LINE_HIT_TOLERANCE &&
      point.y <= box.y + box.height + LINE_HIT_TOLERANCE;
    return within ? { id: drawing.id } : null;
  }

  if (drawing.type === "horizontal") {
    if (dist(point, p1) < HANDLE_HIT_RADIUS) return { id: drawing.id, handle: "p1" };
    return Math.abs(point.y - p1.y) < LINE_HIT_TOLERANCE ? { id: drawing.id } : null;
  }
  if (drawing.type === "vertical") {
    if (dist(point, p1) < HANDLE_HIT_RADIUS) return { id: drawing.id, handle: "p1" };
    return Math.abs(point.x - p1.x) < LINE_HIT_TOLERANCE ? { id: drawing.id } : null;
  }
  if (drawing.type === "text") {
    return dist(point, p1) < 14 ? { id: drawing.id, handle: "p1" } : null;
  }

  // Lines, rays, arrows, fib, measure: endpoint handles + segment hit-test.
  if (dist(point, p1) < HANDLE_HIT_RADIUS) return { id: drawing.id, handle: "p1" };
  if (dist(point, p2) < HANDLE_HIT_RADIUS) return { id: drawing.id, handle: "p2" };
  const segEnd = drawing.type === "ray" ? extendRayToEdge(p1, p2, chartWidth) : p2;
  return distanceToSegment(point, p1, segEnd) < LINE_HIT_TOLERANCE ? { id: drawing.id } : null;
}

export function isBoxTool(type) {
  return type === "rectangle" || type === "long-position" || type === "short-position" || type === "risk-reward";
}

export function rectFromPoints(p1, p2) {
  return {
    x: Math.min(p1.x, p2.x),
    y: Math.min(p1.y, p2.y),
    width: Math.abs(p2.x - p1.x),
    height: Math.abs(p2.y - p1.y),
  };
}

/** Extend a ray from p1 through p2 to the edge of the visible chart, instead of a hardcoded pixel constant. */
export function extendRayToEdge(p1, p2, chartWidth = 2000) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const margin = Math.max(chartWidth, 200) * 4; // comfortably past any realistic viewport/zoom
  if (Math.abs(dx) < 1e-6) {
    return { x: p1.x, y: p2.y >= p1.y ? p1.y + margin : p1.y - margin };
  }
  const targetX = dx >= 0 ? p1.x + margin : p1.x - margin;
  const slope = dy / dx;
  return { x: targetX, y: p1.y + slope * (targetX - p1.x) };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

// ---------------------------------------------------------------------------
// Labels & formatting (always via the Adaptive Price Precision formatter)
// ---------------------------------------------------------------------------

export function priceLabel(value, precision) {
  return formatPrice(value, precision, { mode: "trading" });
}

export function timeLabel(time) {
  if (!Number.isFinite(time)) return "";
  return new Date(time * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function durationLabel(seconds) {
  const total = Math.round(Math.abs(Number(seconds) || 0));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${total}s`;
}

// ---------------------------------------------------------------------------
// Import / export / normalization
// ---------------------------------------------------------------------------

export function exportDrawingsPayload(context, drawings) {
  return {
    version: 2,
    app: "lensa-crypto-dashboard",
    context,
    exportedAt: new Date().toISOString(),
    drawings,
  };
}

export function normalizeImportedDrawing(raw, fallbackContext) {
  const fallbackAnchor = { time: Math.floor(Date.now() / 1000), price: 0 };
  const p1 = raw?.p1 && Number.isFinite(raw.p1.time) && Number.isFinite(raw.p1.price) ? raw.p1 : fallbackAnchor;
  const p2 = raw?.p2 && Number.isFinite(raw.p2.time) && Number.isFinite(raw.p2.price) ? raw.p2 : p1;
  return {
    id: raw?.id || makeDrawingId(raw?.type || "trendline"),
    version: 2,
    type: DRAWING_TOOLS.some((tool) => tool.id === raw?.type) ? raw.type : "trendline",
    context: raw?.context || fallbackContext,
    p1,
    p2,
    color: raw?.color || "#f59e0b",
    width: clampWidth(raw?.width),
    lineStyle: raw?.lineStyle || raw?.style || "solid",
    visible: raw?.visible !== false,
    locked: Boolean(raw?.locked),
    text: raw?.text,
    createdAt: raw?.createdAt || new Date().toISOString(),
  };
}

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
