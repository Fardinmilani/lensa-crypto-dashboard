import { useState } from "react";
import { TIMEFRAMES } from "../lib/coingecko";

/**
 * Lets the user pick a preset timeframe OR type an arbitrary number of days.
 * `value` is the number of days; `onChange(days)` reports changes.
 */
export default function TimeframePicker({ value, onChange }) {
  const [custom, setCustom] = useState("");
  const isPreset = TIMEFRAMES.some((t) => t.days === value);

  function applyCustom() {
    const n = Math.round(Number(custom));
    if (Number.isFinite(n) && n >= 1 && n <= 3650) onChange(n);
  }

  return (
    <div className="tf-picker" role="group" aria-label="انتخاب بازه زمانی">
      <div className="tf-presets">
        {TIMEFRAMES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tf-chip ${value === t.days ? "is-active" : ""}`}
            onClick={() => onChange(t.days)}
            title={t.intraday ? "شامل کندل‌های درون‌روزی" : "کندل روزانه"}
          >
            {t.label}
          </button>
        ))}
        {!isPreset && <span className="tf-chip is-active is-custom">{value} روز</span>}
      </div>
      <div className="tf-custom">
        <input
          type="number"
          min="1"
          max="3650"
          placeholder="روز دلخواه"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && applyCustom()}
          aria-label="تعداد روز دلخواه"
        />
        <button type="button" className="tf-custom__btn" onClick={applyCustom}>
          اعمال
        </button>
      </div>
    </div>
  );
}
