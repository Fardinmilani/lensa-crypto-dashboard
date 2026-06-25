import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DRAWING_TOOL_GROUPS,
  DRAWING_TOOLS,
  FIB_LEVELS,
  LINE_STYLES,
  SINGLE_POINT_TOOLS,
  TWO_POINT_TOOLS,
  anchorFromPixel,
  anchorToPixel,
  applyDrag,
  clampWidth,
  drawingCompatibility,
  durationLabel,
  exportDrawingsPayload,
  extendRayToEdge,
  hitTestAny,
  hitTestDrawings,
  isBoxTool,
  makeDrawing,
  normalizeImportedDrawing,
  priceLabel,
  rectFromPoints,
  snapAnchorToOhlc,
  timeLabel,
  toolLabel,
} from "../lib/drawings";
import { useLocalStorageState } from "../hooks/useLocalStorageState";

const HISTORY_LIMIT = 30;

/**
 * Self-contained TradingView-style drawing system. Renders its own left
 * toolbar + SVG overlay + side panels. Owns its own state (drawings,
 * selection, undo/redo, tool/style prefs) so PriceChart only needs to mount
 * this once per chart instance and otherwise leave it alone.
 *
 * Props:
 *   chart, series   — live lightweight-charts handles (re-render on pan/zoom via renderTick)
 *   candles         — current candle array, used for magnet snapping
 *   context         — { exchange, market, symbol, timeframe } identity of the current chart
 *   renderTick      — bump this number whenever the chart's visible range changes
 *   stageRef        — ref to the wrapping element used for pointer→pixel math
 */
export default function ChartDrawingLayer({ chart, series, candles, context, renderTick, stageRef }) {
  // renderTick is intentionally unused beyond being a prop: PriceChart bumps it on every
  // chart pan/zoom/resize, and receiving it as a prop is what makes this component
  // re-render and recompute every anchorToPixel(...) projection in the JSX below.
  void renderTick;
  const storageKey = useMemo(
    () => `lensa.drawings.v2.${context.exchange}.${context.market}.${context.symbol}.${context.timeframe}`,
    [context.exchange, context.market, context.symbol, context.timeframe]
  );
  const [drawings, setDrawings] = useLocalStorageState(storageKey, []);
  const [tool, setTool] = useState("select");
  const [selectedId, setSelectedId] = useState(null);
  const [hoverId, setHoverId] = useState(null);
  const [magnet, setMagnet] = useLocalStorageState("lensa.drawing.magnet", true);
  const [style, setStyle] = useLocalStorageState("lensa.drawing.style", { color: "#f5a623", width: 2, lineStyle: "solid" });
  const [panel, setPanel] = useState(null); // null | "objects" | "settings"
  const [pendingPoint, setPendingPoint] = useState(null); // first click of a two-point tool, in data space
  const [livePoint, setLivePoint] = useState(null); // current cursor anchor, for the rubber-band preview
  const [importError, setImportError] = useState(null);

  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const dragState = useRef(null); // { id, handle, startAnchor, original }
  const fileInputRef = useRef(null);

  const chartWidth = stageRef.current?.clientWidth || 1000;
  const selected = drawings.find((d) => d.id === selectedId) || null;
  const activeTool = DRAWING_TOOLS.find((t) => t.id === tool) || DRAWING_TOOLS[0];

  const pushHistory = useCallback(() => {
    undoStack.current = [...undoStack.current.slice(-HISTORY_LIMIT + 1), drawings];
    redoStack.current = [];
  }, [drawings]);

  const commitDrawings = useCallback(
    (next, { history = true } = {}) => {
      if (history) pushHistory();
      setDrawings(typeof next === "function" ? next(drawings) : next);
    },
    [drawings, pushHistory, setDrawings]
  );

  function undo() {
    const previous = undoStack.current.at(-1);
    if (previous === undefined) return;
    redoStack.current = [drawings, ...redoStack.current].slice(0, HISTORY_LIMIT);
    undoStack.current = undoStack.current.slice(0, -1);
    setDrawings(previous);
  }
  function redo() {
    const next = redoStack.current[0];
    if (next === undefined) return;
    undoStack.current = [...undoStack.current, drawings];
    redoStack.current = redoStack.current.slice(1);
    setDrawings(next);
  }

  function selectTool(nextTool) {
    setTool(nextTool);
    setPendingPoint(null);
    setLivePoint(null);
    setSelectedId(null);
  }

  function readAnchor(clientX, clientY) {
    if (!stageRef.current || !chart || !series) return null;
    const rect = stageRef.current.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, rect.width);
    const y = clamp(clientY - rect.top, 0, rect.height);
    const anchor = anchorFromPixel(x, y, chart, series);
    if (!anchor) return null;
    return magnet ? snapAnchorToOhlc(anchor, candles) : anchor;
  }

  function pixelPoint(clientX, clientY) {
    const rect = stageRef.current.getBoundingClientRect();
    return { x: clamp(clientX - rect.left, 0, rect.width), y: clamp(clientY - rect.top, 0, rect.height) };
  }

  function handlePointerDown(e) {
    const anchor = readAnchor(e.clientX, e.clientY);
    if (!anchor) return;

    if (tool !== "select") {
      e.preventDefault();
      if (SINGLE_POINT_TOOLS.has(tool)) {
        const drawing = makeDrawing(tool, anchor, anchor, style, context);
        commitDrawings([...drawings, drawing]);
        setSelectedId(drawing.id);
        selectTool("select");
        return;
      }
      if (TWO_POINT_TOOLS.has(tool)) {
        if (!pendingPoint) {
          setPendingPoint(anchor);
          setLivePoint(anchor);
          return;
        }
        const drawing = makeDrawing(tool, pendingPoint, anchor, style, context);
        commitDrawings([...drawings, drawing]);
        setSelectedId(drawing.id);
        setPendingPoint(null);
        setLivePoint(null);
        selectTool("select");
      }
      return;
    }

    // Select mode: hit-test for a handle/shape to grab.
    const point = pixelPoint(e.clientX, e.clientY);
    const hit = hitTestDrawings(drawings, point, chart, series, chartWidth);
    if (!hit) {
      setSelectedId(null);
      return;
    }
    setSelectedId(hit.id);
    const drawing = drawings.find((d) => d.id === hit.id);
    if (!drawing) return;
    e.preventDefault();
    pushHistory();
    dragState.current = { id: hit.id, handle: hit.handle, startAnchor: anchor, original: drawing };
  }

  function handlePointerMove(e) {
    const drag = dragState.current;
    if (drag) {
      const anchor = readAnchor(e.clientX, e.clientY);
      if (!anchor) return;
      e.preventDefault();
      setDrawings((prev) =>
        prev.map((d) => (d.id === drag.id ? applyDrag(d, drag.handle, drag.startAnchor, anchor, drag.original) : d))
      );
      return;
    }

    if (tool !== "select" && pendingPoint) {
      const anchor = readAnchor(e.clientX, e.clientY);
      if (anchor) setLivePoint(anchor);
      return;
    }

    if (tool === "select") {
      const point = pixelPoint(e.clientX, e.clientY);
      const hit = hitTestAny(drawings, point, chart, series, chartWidth);
      setHoverId(hit?.id ?? null);
    }
  }

  function handlePointerUp() {
    if (dragState.current) dragState.current = null;
  }

  function handleDoubleClick() {
    // Escape mid-placement of a two-point tool without committing a shape.
    if (pendingPoint) {
      setPendingPoint(null);
      setLivePoint(null);
    }
  }

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === "Escape") {
        if (pendingPoint) {
          setPendingPoint(null);
          setLivePoint(null);
        } else if (tool !== "select") {
          selectTool("select");
        } else {
          setSelectedId(null);
        }
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId && !isTypingTarget(e.target)) {
        e.preventDefault();
        deleteSelected();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPoint, tool, selectedId, drawings]);

  function patchDrawing(id, patch) {
    setDrawings((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }
  function patchSelected(patch) {
    if (selectedId) patchDrawing(selectedId, patch);
  }
  function deleteSelected() {
    if (!selectedId) return;
    commitDrawings(drawings.filter((d) => d.id !== selectedId));
    setSelectedId(null);
  }
  function clearAll() {
    if (!drawings.length) return;
    commitDrawings([]);
    setSelectedId(null);
  }

  function exportJson() {
    const payload = exportDrawingsPayload(context, drawings);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `lensa-drawings-${context.exchange}-${context.market}-${context.symbol}-${context.timeframe}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function importJson(file) {
    if (!file) return;
    setImportError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || "{}"));
        const list = Array.isArray(parsed.drawings) ? parsed.drawings : Array.isArray(parsed) ? parsed : null;
        if (!list) throw new Error("no drawings array");
        commitDrawings([...drawings, ...list.map((d) => normalizeImportedDrawing(d, context))]);
      } catch {
        setImportError("That file isn't valid Lensa drawing JSON.");
      }
    };
    reader.readAsText(file);
  }

  const cursorClass = tool !== "select" ? "is-placing" : dragState.current ? "is-dragging" : hoverId ? "is-hovering" : "is-selecting";

  return (
    <>
      <aside className="dtool-bar no-print">
        <div className="dtool-bar__groups">
          {DRAWING_TOOL_GROUPS.map((group) => {
            const activeInGroup = group.tools.includes(tool);
            const shown = activeInGroup ? activeTool : DRAWING_TOOLS.find((t) => t.id === group.tools[0]);
            return (
              <div className="dtool-group" key={group.id}>
                <button
                  type="button"
                  className={`dtool-btn${activeInGroup ? " is-active" : ""}`}
                  onClick={() => selectTool(group.tools[0])}
                  title={shown.label}
                >
                  <ToolIcon name={shown.icon} />
                </button>
                {group.tools.length > 1 && (
                  <div className="dtool-flyout">
                    {group.tools.map((toolId) => {
                      const def = DRAWING_TOOLS.find((t) => t.id === toolId);
                      return (
                        <button
                          type="button"
                          key={toolId}
                          className={`dtool-flyout__item${tool === toolId ? " is-active" : ""}`}
                          onClick={() => selectTool(toolId)}
                        >
                          <ToolIcon name={def.icon} />
                          <span>{def.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="dtool-bar__sep" />

        <button
          type="button"
          className={`dtool-btn${magnet ? " is-active" : ""}`}
          onClick={() => setMagnet((v) => !v)}
          title={magnet ? "Magnet: snapping to OHLC points" : "Free placement: exact cursor position"}
        >
          <ToolIcon name="magnet" />
        </button>
        <label className="dtool-btn dtool-btn--color" title="Drawing color">
          <span className="dtool-swatch" style={{ background: style.color }} />
          <input type="color" value={style.color} onChange={(e) => setStyle((p) => ({ ...p, color: e.target.value }))} />
        </label>
        <div className="dtool-widths">
          {[1, 2, 3, 4].map((w) => (
            <button
              key={w}
              type="button"
              className={`dtool-width${style.width === w ? " is-active" : ""}`}
              onClick={() => setStyle((p) => ({ ...p, width: w }))}
              title={`Line width ${w}`}
            >
              <span style={{ height: `${w}px` }} />
            </button>
          ))}
        </div>

        <div className="dtool-bar__sep" />

        <button type="button" className="dtool-btn" onClick={undo} disabled={!undoStack.current.length} title="Undo (Ctrl+Z)">
          <ToolIcon name="undo" />
        </button>
        <button type="button" className="dtool-btn" onClick={redo} disabled={!redoStack.current.length} title="Redo (Ctrl+Shift+Z)">
          <ToolIcon name="redo" />
        </button>
        <button
          type="button"
          className={`dtool-btn${panel === "objects" ? " is-active" : ""}`}
          onClick={() => setPanel((p) => (p === "objects" ? null : "objects"))}
          title="Object tree"
        >
          <ToolIcon name="layers" />
        </button>
        <button
          type="button"
          className={`dtool-btn${panel === "settings" ? " is-active" : ""}`}
          onClick={() => setPanel((p) => (p === "settings" ? null : "settings"))}
          title="Drawing settings"
        >
          <ToolIcon name="settings" />
        </button>

        <div className="dtool-bar__sep" />

        <button type="button" className="dtool-btn" onClick={exportJson} title="Export drawings as JSON" disabled={!drawings.length}>
          <ToolIcon name="export" />
        </button>
        <label className="dtool-btn" title="Import drawings from JSON">
          <ToolIcon name="import" />
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              importJson(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
        <button
          type="button"
          className="dtool-btn dtool-btn--danger"
          onClick={deleteSelected}
          disabled={!selectedId}
          title="Delete selected (Del)"
        >
          <ToolIcon name="trash" />
        </button>
        <button type="button" className="dtool-btn dtool-btn--danger" onClick={clearAll} disabled={!drawings.length} title="Clear all drawings">
          <ToolIcon name="clear" />
        </button>
      </aside>

      <svg
        className={`dlayer ${cursorClass}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onDoubleClick={handleDoubleClick}
      >
        <defs>
          <marker id="dlayer-arrowhead" markerWidth="9" markerHeight="9" refX="7.5" refY="4.5" orient="auto">
            <path d="M0,0 L9,4.5 L0,9 Z" fill="context-fill" />
          </marker>
        </defs>
        {drawings.map((drawing) => (
          <DrawingShape
            key={drawing.id}
            drawing={drawing}
            chart={chart}
            series={series}
            chartWidth={chartWidth}
            selected={drawing.id === selectedId}
            hovered={drawing.id === hoverId}
            context={context}
          />
        ))}
        {pendingPoint && livePoint && (
          <LivePreview tool={tool} p1={pendingPoint} p2={livePoint} chart={chart} series={series} chartWidth={chartWidth} style={style} />
        )}
        {pendingPoint && !livePoint && <AnchorDot anchor={pendingPoint} chart={chart} series={series} color={style.color} />}
      </svg>

      {tool !== "select" && (
        <div className="dlayer__hint no-print">
          {SINGLE_POINT_TOOLS.has(tool)
            ? `Click to place ${activeTool.label.toLowerCase()}`
            : pendingPoint
              ? `Click to finish ${activeTool.label.toLowerCase()} · Esc to cancel`
              : `Click the first point of the ${activeTool.label.toLowerCase()}`}
        </div>
      )}

      {panel && (
        <aside className="dpanel no-print">
          {panel === "objects" && (
            <ObjectTree drawings={drawings} selectedId={selectedId} context={context} onSelect={setSelectedId} onPatch={patchDrawing} />
          )}
          {panel === "settings" && <SettingsPanel drawing={selected} onPatch={patchSelected} onDelete={deleteSelected} />}
        </aside>
      )}
      {importError && <div className="dlayer__error no-print">{importError}</div>}
    </>
  );
}

function isTypingTarget(el) {
  return el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function DrawingShape({ drawing, chart, series, chartWidth, selected, hovered, context }) {
  if (drawing.visible === false) return null;
  const compat = drawingCompatibility(drawing, context);
  const p1 = anchorToPixel(drawing.p1, chart, series);
  const p2 = anchorToPixel(drawing.p2 || drawing.p1, chart, series);
  if (!p1 || !p2) {
    return <InactiveBadge drawing={drawing} compat={compat} />;
  }

  const dash = compat.status === "active" ? LINE_STYLES[drawing.lineStyle]?.dash : "3 5";
  const opacity = compat.status === "inactive" ? 0.32 : compat.status === "partial" ? 0.65 : 1;
  const strokeWidth = clampWidth(drawing.width) + (hovered && !selected ? 0.5 : 0);
  const stroke = {
    stroke: drawing.color,
    strokeWidth,
    strokeDasharray: dash,
    strokeLinecap: "round",
    fill: "none",
    opacity,
  };
  const groupClass = `dshape${selected ? " is-selected" : ""}${hovered ? " is-hovered" : ""}${compat.status !== "active" ? " is-degraded" : ""}`;
  const showHandles = selected && !drawing.locked;

  if (drawing.type === "horizontal") {
    return (
      <g className={groupClass} style={{ "--shape-color": drawing.color }}>
        <line x1={0} y1={p1.y} x2="100%" y2={p1.y} {...stroke} />
        <PriceTag x={6} y={p1.y} text={priceLabel(drawing.p1.price, undefined)} color={drawing.color} compat={compat} />
        {showHandles && <Handle x={p1.x} y={p1.y} cursor="ns-resize" />}
      </g>
    );
  }

  if (drawing.type === "vertical") {
    return (
      <g className={groupClass} style={{ "--shape-color": drawing.color }}>
        <line x1={p1.x} y1={0} x2={p1.x} y2="100%" {...stroke} />
        <text className="dlabel" x={p1.x + 6} y={16}>{timeLabel(drawing.p1.time)}</text>
        {showHandles && <Handle x={p1.x} y={p1.y} cursor="ew-resize" />}
      </g>
    );
  }

  if (drawing.type === "text") {
    return (
      <g className={groupClass} style={{ "--shape-color": drawing.color }}>
        <text className="dlabel dlabel--note" x={p1.x} y={p1.y} fill={drawing.color}>
          {drawing.text || "Note"}
        </text>
        {showHandles && <Handle x={p1.x} y={p1.y} cursor="move" />}
      </g>
    );
  }

  if (drawing.type === "rectangle") {
    const box = rectFromPoints(p1, p2);
    return (
      <g className={groupClass} style={{ "--shape-color": drawing.color }}>
        <rect {...box} {...stroke} fill={`${drawing.color}1f`} />
        {showHandles && <BoxHandles p1={p1} p2={p2} />}
      </g>
    );
  }

  if (drawing.type === "fib") {
    return <FibShape drawing={drawing} p1={p1} p2={p2} stroke={stroke} groupClass={groupClass} showHandles={showHandles} />;
  }

  if (drawing.type === "long-position" || drawing.type === "short-position" || drawing.type === "risk-reward") {
    return (
      <PositionShape
        drawing={drawing}
        p1={p1}
        p2={p2}
        strokeWidth={strokeWidth}
        opacity={opacity}
        groupClass={groupClass}
        showHandles={showHandles}
      />
    );
  }

  if (drawing.type === "measure") {
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const diff = drawing.p2.price - drawing.p1.price;
    const pct = drawing.p1.price ? (diff / drawing.p1.price) * 100 : 0;
    const seconds = Math.abs(drawing.p2.time - drawing.p1.time);
    const up = diff >= 0;
    return (
      <g className={groupClass} style={{ "--shape-color": drawing.color }}>
        <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} {...stroke} strokeDasharray="4 4" />
        <rect x={Math.min(p1.x, p2.x)} y={Math.min(p1.y, p2.y)} width={Math.abs(p2.x - p1.x)} height={Math.abs(p2.y - p1.y)} fill={up ? "#22c55e14" : "#ef444414"} stroke="none" />
        <g transform={`translate(${mid.x},${mid.y - 10})`}>
          <rect x={-58} y={-16} width={116} height={36} rx={6} fill="rgba(10,13,22,0.92)" stroke={up ? "#22c55e" : "#ef4444"} strokeWidth={1} />
          <text className="dlabel dlabel--measure" x={0} y={-2} fill={up ? "#22c55e" : "#ef4444"} textAnchor="middle">
            {priceLabel(diff)} ({pct >= 0 ? "+" : ""}{pct.toFixed(2)}%)
          </text>
          <text className="dlabel dlabel--measure-sub" x={0} y={13} fill="var(--text-secondary)" textAnchor="middle">
            {durationLabel(seconds)}
          </text>
        </g>
        {showHandles && <BoxHandles p1={p1} p2={p2} />}
      </g>
    );
  }

  // trendline / ray / arrow
  const end = drawing.type === "ray" ? extendRayToEdge(p1, p2, chartWidth) : p2;
  return (
    <g className={groupClass} style={{ "--shape-color": drawing.color }}>
      <line
        x1={p1.x}
        y1={p1.y}
        x2={end.x}
        y2={end.y}
        {...stroke}
        markerEnd={drawing.type === "arrow" ? "url(#dlayer-arrowhead)" : undefined}
        color={drawing.color}
      />
      {showHandles && (
        <>
          <Handle x={p1.x} y={p1.y} cursor="move" />
          <Handle x={p2.x} y={p2.y} cursor="move" />
        </>
      )}
    </g>
  );
}

function FibShape({ drawing, p1, p2, stroke, groupClass, showHandles }) {
  const x1 = Math.min(p1.x, p2.x);
  const x2 = Math.max(p1.x, p2.x);
  const priceDelta = drawing.p2.price - drawing.p1.price;
  return (
    <g className={groupClass} style={{ "--shape-color": drawing.color }}>
      {FIB_LEVELS.map((level) => {
        const price = drawing.p1.price + priceDelta * level;
        const y = p1.y + (p2.y - p1.y) * level;
        return (
          <g key={level}>
            <line x1={x1} x2={x2} y1={y} y2={y} {...stroke} strokeDasharray="5 4" />
            <text className="dlabel dlabel--fib" x={x2 + 6} y={y}>
              {(level * 100).toFixed(1)}% &middot; {priceLabel(price)}
            </text>
          </g>
        );
      })}
      {showHandles && <BoxHandles p1={p1} p2={p2} />}
    </g>
  );
}

function PositionShape({ drawing, p1, p2, strokeWidth, opacity, groupClass, showHandles }) {
  const isShort = drawing.type === "short-position";
  const entry = drawing.p1.price;
  const target = drawing.p2.price;
  const riskSpan = Math.abs(target - entry) / 2 || Math.abs(entry) * 0.01 || 1;
  const stop = isShort || (drawing.type === "risk-reward" && target < entry) ? entry + riskSpan : entry - riskSpan;
  const stopY = p1.y + (stop - entry) * ((p2.y - p1.y) / ((target - entry) || 1));
  const rewardBox = rectFromPoints(p1, p2);
  const riskBox = rectFromPoints(p1, { x: p2.x, y: stopY });
  const rr = Math.abs(target - entry) / Math.max(1e-9, Math.abs(entry - stop));
  const rightX = Math.max(p1.x, p2.x) + 8;
  return (
    <g className={groupClass} style={{ "--shape-color": drawing.color, opacity }}>
      <rect {...riskBox} fill="rgba(239,68,68,0.16)" stroke="#ef4444" strokeWidth={strokeWidth} />
      <rect {...rewardBox} fill="rgba(34,197,94,0.16)" stroke="#22c55e" strokeWidth={strokeWidth} />
      <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p1.y} stroke={drawing.color} strokeWidth={strokeWidth} strokeDasharray="3 4" />
      <text className="dlabel dlabel--pos" x={rightX} y={p1.y} fill={drawing.color}>Entry {priceLabel(entry)}</text>
      <text className="dlabel dlabel--pos" x={rightX} y={p2.y} fill="#22c55e">Target {priceLabel(target)}</text>
      <text className="dlabel dlabel--pos" x={rightX} y={stopY} fill="#ef4444">Stop {priceLabel(stop)} &middot; R:R 1:{rr.toFixed(2)}</text>
      {showHandles && <BoxHandles p1={p1} p2={p2} />}
    </g>
  );
}

function BoxHandles({ p1, p2 }) {
  return (
    <g className="dhandles">
      <Handle x={p1.x} y={p1.y} cursor="nwse-resize" />
      <Handle x={p2.x} y={p2.y} cursor="nwse-resize" />
      <Handle x={p2.x} y={p1.y} cursor="nesw-resize" />
      <Handle x={p1.x} y={p2.y} cursor="nesw-resize" />
    </g>
  );
}

function Handle({ x, y, cursor }) {
  return <circle className="dhandle" cx={x} cy={y} r={5.5} style={{ cursor }} />;
}

function PriceTag({ x, y, text, color, compat }) {
  return (
    <g>
      <rect x={x - 4} y={y - 14} width={text.length * 6.6 + 8} height={18} rx={4} fill="rgba(8,10,17,0.88)" stroke={color} strokeOpacity={0.5} />
      <text className={`dlabel dlabel--price${compat.status !== "active" ? " is-degraded" : ""}`} x={x} y={y} fill={color}>
        {text}
      </text>
    </g>
  );
}

function InactiveBadge({ drawing, compat }) {
  return (
    <foreignObject x="8" y="8" width="280" height="28" className="dbadge-host">
      <div className="dbadge" title={compat.message}>
        {toolLabel(drawing.type)} — off-screen / {compat.status}
      </div>
    </foreignObject>
  );
}

function AnchorDot({ anchor, chart, series, color }) {
  const p = anchorToPixel(anchor, chart, series);
  if (!p) return null;
  return <circle className="danchor" cx={p.x} cy={p.y} r={4} fill={color} />;
}

/** The live rubber-band preview shown while placing a two-point tool, before the second click. */
function LivePreview({ tool, p1: dataP1, p2: dataP2, chart, series, chartWidth, style }) {
  const p1 = anchorToPixel(dataP1, chart, series);
  const p2 = anchorToPixel(dataP2, chart, series);
  if (!p1 || !p2) return null;
  const common = { stroke: style.color, strokeWidth: clampWidth(style.width), strokeDasharray: "5 4", fill: "none", opacity: 0.85 };

  if (tool === "rectangle" || isBoxTool(tool)) {
    const box = rectFromPoints(p1, p2);
    return (
      <g className="dpreview">
        <rect {...box} {...common} fill={`${style.color}14`} />
        <AnchorDot anchor={dataP1} chart={chart} series={series} color={style.color} />
      </g>
    );
  }
  if (tool === "fib") {
    const x1 = Math.min(p1.x, p2.x);
    const x2 = Math.max(p1.x, p2.x);
    return (
      <g className="dpreview">
        {FIB_LEVELS.map((level) => {
          const y = p1.y + (p2.y - p1.y) * level;
          return <line key={level} x1={x1} x2={x2} y1={y} y2={y} {...common} />;
        })}
      </g>
    );
  }
  const end = tool === "ray" ? extendRayToEdge(p1, p2, chartWidth) : p2;
  return (
    <g className="dpreview">
      <line x1={p1.x} y1={p1.y} x2={end.x} y2={end.y} {...common} markerEnd={tool === "arrow" ? "url(#dlayer-arrowhead)" : undefined} />
      <AnchorDot anchor={dataP1} chart={chart} series={series} color={style.color} />
    </g>
  );
}

// ---------------------------------------------------------------------------
// Side panels
// ---------------------------------------------------------------------------

function ObjectTree({ drawings, selectedId, context, onSelect, onPatch }) {
  return (
    <div className="dpanel__section">
      <div className="dpanel__head">
        <strong>Object tree</strong>
        <span className="dpanel__count">{drawings.length}</span>
      </div>
      <div className="dpanel__context">
        {context.exchange} &middot; {context.market} &middot; {context.symbol} &middot; {context.timeframe}
      </div>
      <div className="dpanel__list">
        {drawings.length === 0 && <p className="dpanel__empty">No drawings on this chart yet.</p>}
        {drawings.map((drawing) => {
          const compat = drawingCompatibility(drawing, context);
          return (
            <div key={drawing.id} className={`dobject${selectedId === drawing.id ? " is-selected" : ""}`} onClick={() => onSelect(drawing.id)}>
              <span className="dobject__swatch" style={{ background: drawing.color }} />
              <span className="dobject__label">
                <b>{toolLabel(drawing.type)}</b>
                <small className={compat.status !== "active" ? "is-degraded" : ""}>{compat.message || "On this chart"}</small>
              </span>
              <button
                type="button"
                className="dobject__icon"
                title={drawing.visible === false ? "Show" : "Hide"}
                onClick={(e) => {
                  e.stopPropagation();
                  onPatch(drawing.id, { visible: drawing.visible === false });
                }}
              >
                <ToolIcon name={drawing.visible === false ? "eye-off" : "eye"} />
              </button>
              <button
                type="button"
                className="dobject__icon"
                title={drawing.locked ? "Unlock" : "Lock"}
                onClick={(e) => {
                  e.stopPropagation();
                  onPatch(drawing.id, { locked: !drawing.locked });
                }}
              >
                <ToolIcon name={drawing.locked ? "lock" : "unlock"} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SettingsPanel({ drawing, onPatch, onDelete }) {
  if (!drawing) {
    return (
      <div className="dpanel__section">
        <div className="dpanel__head"><strong>Drawing settings</strong></div>
        <p className="dpanel__empty">Select a drawing to edit it.</p>
      </div>
    );
  }
  return (
    <div className="dpanel__section">
      <div className="dpanel__head">
        <strong>Drawing settings</strong>
        <span className="dpanel__count">{toolLabel(drawing.type)}</span>
      </div>
      <label className="dpanel__field">
        Color
        <input type="color" value={drawing.color} onChange={(e) => onPatch({ color: e.target.value })} />
      </label>
      <label className="dpanel__field">
        Width
        <input type="number" min={1} max={6} value={drawing.width} onChange={(e) => onPatch({ width: clampWidth(e.target.value) })} />
      </label>
      <label className="dpanel__field">
        Style
        <select value={drawing.lineStyle} onChange={(e) => onPatch({ lineStyle: e.target.value })}>
          {Object.entries(LINE_STYLES).map(([key, def]) => (
            <option key={key} value={key}>{def.label}</option>
          ))}
        </select>
      </label>
      {drawing.type === "text" && (
        <label className="dpanel__field">
          Text
          <input value={drawing.text || ""} onChange={(e) => onPatch({ text: e.target.value })} />
        </label>
      )}
      <div className="dpanel__prices">
        <span>P1 {priceLabel(drawing.p1?.price)}</span>
        {drawing.p2 && drawing.p2 !== drawing.p1 && <span>P2 {priceLabel(drawing.p2.price)}</span>}
      </div>
      <div className="dpanel__actions">
        <button type="button" className="dpanel__ghost" onClick={() => onPatch({ locked: !drawing.locked })}>
          {drawing.locked ? "Unlock" : "Lock"}
        </button>
        <button type="button" className="dpanel__ghost" onClick={() => onPatch({ visible: drawing.visible === false })}>
          {drawing.visible === false ? "Show" : "Hide"}
        </button>
        <button type="button" className="dpanel__ghost dpanel__ghost--danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Minimal icon set (inline SVG paths, no external icon library needed)
// ---------------------------------------------------------------------------

const ICONS = {
  cursor: "M5 3l13 7-6 1.5L10 18z",
  trendline: "M3 18L18 4",
  ray: "M3 18L18 4M18 4l-3 1m3-1l-1 3",
  horizontal: "M3 10h14",
  vertical: "M10 3v14",
  arrow: "M3 18L17 4M17 4h-5m5 0v5",
  rectangle: "M4 5h12v10H4z",
  fib: "M3 5h14M3 9h14M3 13h14M3 17h14",
  text: "M5 5h10M10 5v12M7 17h6",
  measure: "M3 14h14M5 11v6M9 11v6M13 11v6M17 11v6",
  long: "M3 17l5-5 4 3 6-7",
  short: "M3 5l5 5 4-3 6 7",
  rr: "M4 5h12v6H4zM4 13h12v4H4z",
  magnet: "M6 3v7a4 4 0 008 0V3M6 3H4m2 0h2m6 0h2m-2 0h-2",
  undo: "M7 8L3 8m0 0l4-4m-4 4l4 4M3 8c0 5 4 9 9 9 4 0 7-2 8-5",
  redo: "M13 8l4 0m0 0l-4-4m4 4l-4 4M17 8c0 5-4 9-9 9-4 0-7-2-8-5",
  layers: "M10 3l8 4-8 4-8-4zM2 11l8 4 8-4M2 15l8 4 8-4",
  settings: "M10 6a4 4 0 100 8 4 4 0 000-8zM10 1v2m0 14v2M3.5 3.5l1.4 1.4m10.2 10.2l1.4 1.4M1 10h2m14 0h2M3.5 16.5l1.4-1.4m10.2-10.2l1.4-1.4",
  export: "M10 13V3m0 0L6 7m4-4l4 4M4 14v3h12v-3",
  import: "M10 3v10m0 0l-4-4m4 4l4-4M4 14v3h12v-3",
  trash: "M4 6h12M8 6V4h4v2m-7 0l1 11h8l1-11",
  clear: "M4 4l12 12M16 4L4 16",
  eye: "M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z M10 12a2 2 0 100-4 2 2 0 000 4z",
  "eye-off": "M3 3l14 14M8.5 8.7a2 2 0 002.8 2.8M5.6 5.5C3.4 6.8 2 10 2 10s3 5 8 5c1.3 0 2.5-.3 3.5-.8M14.6 6.6C13.3 5.6 11.8 5 10 5c-.6 0-1.2.1-1.7.2M16.7 8.2c.8.9 1.3 1.6 1.3 1.6s-.6 1-1.7 2",
  lock: "M5 9V6a5 5 0 0110 0v3m-12 0h14v9H3z",
  unlock: "M5 9V6a5 5 0 019-3M3 9h14v9H3z",
};

function ToolIcon({ name }) {
  const d = ICONS[name] || ICONS.cursor;
  return (
    <svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
