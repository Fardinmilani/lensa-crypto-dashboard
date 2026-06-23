import { useState } from "react";
import { TIMEFRAMES } from "../lib/coingecko";
import { useI18n } from "../i18n/langStore";

/**
 * Lets the user pick a preset timeframe OR type an arbitrary number of days.
 * `value` is the number of days; `onChange(days)` reports changes.
 */
export default function TimeframePicker({ value, onChange }) {
  const { t } = useI18n();
  const [custom, setCustom] = useState("");
  const isPreset = TIMEFRAMES.some((tf) => tf.days === value);

  function applyCustom() {
    const n = Math.round(Number(custom));
    if (Number.isFinite(n) && n >= 1 && n <= 3650) onChange(n);
  }

  return (
    <div className="tf-picker" role="group" aria-label={t("tf.aria")}>
      <div className="tf-presets">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf.id}
            type="button"
            className={`tf-chip ${value === tf.days ? "is-active" : ""}`}
            onClick={() => onChange(tf.days)}
            title={tf.intraday ? t("tf.intraday") : t("tf.daily")}
          >
            {t(`tf.${tf.id}`)}
          </button>
        ))}
        {!isPreset && <span className="tf-chip is-active is-custom">{t("tf.days", { n: value })}</span>}
      </div>
      <div className="tf-custom">
        <input
          type="number"
          min="1"
          max="3650"
          placeholder={t("tf.custom")}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && applyCustom()}
          aria-label={t("tf.custom")}
        />
        <button type="button" className="tf-custom__btn" onClick={applyCustom}>
          {t("tf.apply")}
        </button>
      </div>
    </div>
  );
}
