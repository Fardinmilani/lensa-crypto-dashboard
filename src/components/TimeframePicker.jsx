import { useState } from "react";
import { TIMEFRAMES } from "../lib/coingecko";
import { useI18n } from "../i18n/langStore";

/**
 * Lets the user pick a TradingView-style preset or type a custom day range.
 * Presets report a timeframe id; custom ranges report a day count.
 */
export default function TimeframePicker({ value, onChange }) {
  const { t } = useI18n();
  const [custom, setCustom] = useState("");
  const isNumericValue = typeof value === "number";
  const isPreset = TIMEFRAMES.some(
    (tf) => tf.id === value || (isNumericValue && tf.days === value && tf.intervalMinutes >= 1440)
  );

  function applyCustom() {
    const n = Math.round(Number(custom));
    if (Number.isFinite(n) && n >= 1 && n <= 3650) onChange(n);
  }

  return (
    <div className="tf-picker" role="group" aria-label={t("tf.aria")}>
      <select
        className="tf-select"
        value={isPreset && !isNumericValue ? value : ""}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        aria-label={t("tf.aria")}
      >
        {isNumericValue && <option value="">{t("tf.days", { n: value })}</option>}
        {TIMEFRAMES.map((tf) => (
          <option key={tf.id} value={tf.id}>
            {t(`tf.${tf.id}`) || tf.label}
          </option>
        ))}
      </select>
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
