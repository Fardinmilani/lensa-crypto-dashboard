import { useId, useRef, useState } from "react";
import { useI18n } from "../i18n/langStore";

export default function InfoTip({ term }) {
  const { t } = useI18n();
  const id = useId();
  const tipId = `infotip-${id.replace(/:/g, "")}`;
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const text = t(term);

  if (!text || text === term) return null;

  function toggle() {
    setOpen((value) => !value);
  }

  function close() {
    setOpen(false);
  }

  return (
    <span className={`info-tip${open ? " info-tip--open" : ""}`} ref={ref}>
      <button
        type="button"
        className="info-tip__trigger"
        aria-describedby={open ? tipId : undefined}
        aria-expanded={open}
        aria-label={t("glossary.moreInfo")}
        onClick={toggle}
        onBlur={(e) => {
          if (!ref.current?.contains(e.relatedTarget)) close();
        }}
      >
        i
      </button>
      <span id={tipId} role="tooltip" className="info-tip__bubble">
        {text}
      </span>
    </span>
  );
}
