import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n/langStore";
import {
  INDICATOR_DEFS,
  INDICATOR_KEYS,
  OPERATORS,
  makeCondition,
  makeIndicatorNode,
  loadCustomDefs,
  saveCustomDef,
  deleteCustomDef,
  newCustomDefId,
} from "../lib/customStrategies";

const INDICATOR_LABELS = {
  close: { en: "Close price", fa: "قیمت پایانی" },
  sma: { en: "SMA", fa: "میانگین متحرک ساده" },
  ema: { en: "EMA", fa: "میانگین متحرک نمایی" },
  rsi: { en: "RSI", fa: "RSI" },
  macdLine: { en: "MACD line", fa: "خط MACD" },
  macdSignal: { en: "MACD signal", fa: "خط سیگنال MACD" },
  bbUpper: { en: "Bollinger upper band", fa: "باند بالای بولینگر" },
  bbMid: { en: "Bollinger middle band", fa: "باند میانی بولینگر" },
  bbLower: { en: "Bollinger lower band", fa: "باند پایین بولینگر" },
  roc: { en: "Rate of change", fa: "نرخ تغییر" },
  highestHigh: { en: "Highest high (N bars)", fa: "بالاترین سقف (N کندل)" },
  lowestLow: { en: "Lowest low (N bars)", fa: "پایین‌ترین کف (N کندل)" },
};

const FIELD_LABELS = {
  period: { en: "Period", fa: "دوره" },
  fast: { en: "Fast", fa: "سریع" },
  slow: { en: "Slow", fa: "کند" },
  signal: { en: "Signal", fa: "سیگنال" },
  mult: { en: "Std-dev ×", fa: "ضریب انحراف معیار" },
};

const OPERATOR_LABELS = {
  ">": { en: "is above", fa: "بزرگ‌تر از" },
  "<": { en: "is below", fa: "کوچک‌تر از" },
  ">=": { en: "is at or above", fa: "بزرگ‌تر یا مساوی" },
  "<=": { en: "is at or below", fa: "کوچک‌تر یا مساوی" },
  crossesAbove: { en: "crosses above", fa: "به‌سمت بالا قطع می‌کند" },
  crossesBelow: { en: "crosses below", fa: "به‌سمت پایین قطع می‌کند" },
};

function pickLocal(lang, dict) {
  return dict?.[lang] || dict?.en || "";
}

function emptyDef() {
  return {
    id: null,
    name: "",
    sustain: "immediate",
    combine: "AND",
    conditions: [makeCondition()],
    exitCombine: "AND",
    exitConditions: [makeCondition()],
    mirrorShort: false,
  };
}

function IndicatorNodeEditor({ lang, node, onChange }) {
  const def = INDICATOR_DEFS[node.type];
  return (
    <div className="sb-node">
      <select value={node.type} onChange={(e) => onChange(makeIndicatorNode(e.target.value))}>
        {INDICATOR_KEYS.map((k) => (
          <option key={k} value={k}>
            {pickLocal(lang, INDICATOR_LABELS[k])}
          </option>
        ))}
      </select>
      {(def?.fields || []).map((f) => (
        <input
          key={f.key}
          type="number"
          className="sb-node__field"
          min={f.min}
          max={f.max}
          value={node[f.key]}
          title={pickLocal(lang, FIELD_LABELS[f.key])}
          onChange={(e) => onChange({ ...node, [f.key]: Number(e.target.value) })}
        />
      ))}
    </div>
  );
}

function ConditionRow({ lang, t, cond, onChange, onRemove }) {
  const isCross = cond.op === "crossesAbove" || cond.op === "crossesBelow";
  return (
    <div className="sb-condition-row">
      <IndicatorNodeEditor lang={lang} node={cond.left} onChange={(left) => onChange({ ...cond, left })} />
      <select value={cond.op} onChange={(e) => onChange({ ...cond, op: e.target.value })}>
        {OPERATORS.map((op) => (
          <option key={op} value={op}>
            {pickLocal(lang, OPERATOR_LABELS[op])}
          </option>
        ))}
      </select>
      {isCross ? null : (
        <div className="sb-right-toggle">
          <button
            type="button"
            className={`chip-toggle${cond.right?.type !== "value" ? " is-active" : ""}`}
            onClick={() => onChange({ ...cond, right: makeIndicatorNode("close") })}
          >
            {t("bt.custom.indicator")}
          </button>
          <button
            type="button"
            className={`chip-toggle${cond.right?.type === "value" ? " is-active" : ""}`}
            onClick={() => onChange({ ...cond, right: { type: "value", value: 0 } })}
          >
            {t("bt.custom.fixedValue")}
          </button>
        </div>
      )}
      {cond.right?.type === "value" ? (
        <input
          type="number"
          className="sb-node__field"
          value={cond.right.value}
          onChange={(e) => onChange({ ...cond, right: { type: "value", value: Number(e.target.value) } })}
        />
      ) : (
        <IndicatorNodeEditor lang={lang} node={cond.right} onChange={(right) => onChange({ ...cond, right })} />
      )}
      <button type="button" className="sb-remove-btn" onClick={onRemove} aria-label={t("bt.custom.removeCondition")}>
        ×
      </button>
    </div>
  );
}

function ConditionGroup({ lang, t, conditions, combine, onChange, onCombineChange }) {
  function updateAt(i, next) {
    onChange(conditions.map((c, idx) => (idx === i ? next : c)));
  }
  function removeAt(i) {
    onChange(conditions.filter((_, idx) => idx !== i));
  }
  return (
    <div className="sb-condition-group">
      {conditions.map((c, i) => (
        <div key={i}>
          {i > 0 && (
            <div className="sb-combine-toggle">
              <button type="button" className={`chip-toggle${combine === "AND" ? " is-active" : ""}`} onClick={() => onCombineChange("AND")}>
                {t("bt.custom.and")}
              </button>
              <button type="button" className={`chip-toggle${combine === "OR" ? " is-active" : ""}`} onClick={() => onCombineChange("OR")}>
                {t("bt.custom.or")}
              </button>
            </div>
          )}
          <ConditionRow lang={lang} t={t} cond={c} onChange={(next) => updateAt(i, next)} onRemove={() => removeAt(i)} />
        </div>
      ))}
      <button type="button" className="run-btn run-btn--ghost sb-add-btn" onClick={() => onChange([...conditions, makeCondition()])}>
        + {t("bt.custom.addCondition")}
      </button>
    </div>
  );
}

/**
 * Backtest page panel for building, saving, and managing custom strategies.
 * Every strategy authored here is a plain JSON condition tree (see
 * lib/customStrategies.js) — there is no code editor and nothing is ever
 * eval()'d, so a saved strategy is exactly as inspectable/auditable as any
 * built-in one, and safe to export/import as plain data.
 */
export default function StrategyBuilder({ t, activeStrategyKey, onSaved, onDeleted, onCountChange }) {
  // Subscribe to the language context (not document.documentElement.lang):
  // reading the DOM attribute is a render-time snapshot that never
  // re-renders on toggle, leaving this builder in the previous language
  // until something else forces an update.
  const { lang } = useI18n();
  const [defs, setDefs] = useState(() => loadCustomDefs());
  const [draft, setDraft] = useState(null);

  useEffect(() => {
    onCountChange?.(defs.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defs.length]);

  const activeIsCustom = useMemo(() => defs.some((d) => d.id === activeStrategyKey), [defs, activeStrategyKey]);

  function startNew() {
    setDraft(emptyDef());
  }
  function startEdit(def) {
    setDraft(JSON.parse(JSON.stringify(def)));
  }
  function cancel() {
    setDraft(null);
  }
  function handleSave() {
    const name = draft.name.trim();
    if (!name) return;
    const def = { ...draft, name, id: draft.id || newCustomDefId() };
    const next = saveCustomDef(def);
    setDefs(next);
    setDraft(null);
    onSaved?.(def.id);
  }
  function handleDelete(id) {
    const next = deleteCustomDef(id);
    setDefs(next);
    onDeleted?.();
  }

  const canSave =
    draft &&
    draft.name.trim().length > 0 &&
    draft.conditions.length > 0 &&
    (draft.sustain !== "hold" || draft.exitConditions.length > 0);

  if (draft) {
    return (
      <div className="sb-editor">
        <div className="control-group control-group--full">
          <label>{t("bt.custom.name")}</label>
          <input
            type="text"
            value={draft.name}
            placeholder={t("bt.custom.namePlaceholder")}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </div>

        <div className="control-group control-group--full">
          <label>
            {t("bt.custom.sustain")} <small className="control-hint">{t("bt.custom.sustain.hint")}</small>
          </label>
          <div className="chip-toggle-group">
            <button
              type="button"
              className={`chip-toggle${draft.sustain === "immediate" ? " is-active" : ""}`}
              onClick={() => setDraft({ ...draft, sustain: "immediate" })}
            >
              {t("bt.custom.sustain.immediate")}
            </button>
            <button
              type="button"
              className={`chip-toggle${draft.sustain === "hold" ? " is-active" : ""}`}
              onClick={() => setDraft({ ...draft, sustain: "hold" })}
            >
              {t("bt.custom.sustain.hold")}
            </button>
          </div>
        </div>

        {draft.sustain === "immediate" ? (
          <>
            <div className="control-group control-group--full">
              <label>{t("bt.custom.conditions")}</label>
              <ConditionGroup
                lang={lang}
                t={t}
                conditions={draft.conditions}
                combine={draft.combine}
                onChange={(conditions) => setDraft({ ...draft, conditions })}
                onCombineChange={(combine) => setDraft({ ...draft, combine })}
              />
            </div>
            <div className="control-group control-group--full">
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={draft.mirrorShort}
                  onChange={(e) => setDraft({ ...draft, mirrorShort: e.target.checked })}
                />
                {t("bt.custom.mirrorShort")}
              </label>
              <small className="control-hint">{t("bt.custom.mirrorShort.hint")}</small>
            </div>
          </>
        ) : (
          <>
            <div className="control-group control-group--full">
              <label>{t("bt.custom.entryConditions")}</label>
              <ConditionGroup
                lang={lang}
                t={t}
                conditions={draft.conditions}
                combine={draft.combine}
                onChange={(conditions) => setDraft({ ...draft, conditions })}
                onCombineChange={(combine) => setDraft({ ...draft, combine })}
              />
            </div>
            <div className="control-group control-group--full">
              <label>{t("bt.custom.exitConditions")}</label>
              <ConditionGroup
                lang={lang}
                t={t}
                conditions={draft.exitConditions}
                combine={draft.exitCombine}
                onChange={(exitConditions) => setDraft({ ...draft, exitConditions })}
                onCombineChange={(exitCombine) => setDraft({ ...draft, exitCombine })}
              />
            </div>
            <small className="control-hint">{t("bt.custom.holdNoShort")}</small>
          </>
        )}

        <div className="run-btn-row">
          <button className="run-btn" onClick={handleSave} disabled={!canSave}>
            {t("bt.custom.save")}
          </button>
          <button className="run-btn run-btn--ghost" onClick={cancel}>
            {t("bt.custom.cancel")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="sb-list">
      {defs.length === 0 && <small className="control-hint">{t("bt.custom.empty")}</small>}
      {defs.map((def) => (
        <div key={def.id} className={`sb-saved-item${def.id === activeStrategyKey ? " is-active" : ""}`}>
          <button type="button" className="sb-saved-item__select" onClick={() => onSaved?.(def.id)}>
            {def.name}
          </button>
          <button type="button" className="sb-saved-item__edit" onClick={() => startEdit(def)}>
            {t("bt.custom.edit")}
          </button>
          <button type="button" className="sb-saved-item__delete" onClick={() => handleDelete(def.id)}>
            {t("bt.custom.delete")}
          </button>
        </div>
      ))}
      <button type="button" className="run-btn run-btn--ghost sb-add-btn" onClick={startNew}>
        + {t("bt.custom.new")}
      </button>
      {activeIsCustom && <small className="control-hint">{t("bt.custom.activeHint")}</small>}
    </div>
  );
}
