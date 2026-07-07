import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/langStore";

export default function InfoTip({ term }) {
  const { t } = useI18n();
  const id = useId();
  const tipId = `infotip-${id.replace(/:/g, "")}`;
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const text = t(term);

  const updatePosition = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 12;
    const estBubbleWidth = Math.min(280, window.innerWidth * 0.8);
    const estBubbleHeight = 90; // rough upper-bound estimate; good enough to decide flip direction
    let left = rect.left + rect.width / 2;
    left = Math.max(estBubbleWidth / 2 + margin, Math.min(left, window.innerWidth - estBubbleWidth / 2 - margin));
    const flipBelow = rect.top < estBubbleHeight + margin;
    setPos({
      top: rect.top,
      bottom: rect.bottom,
      left,
      flipBelow,
    });
  }, []);

  const show = useCallback(() => {
    updatePosition();
    setOpen(true);
  }, [updatePosition]);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  const toggle = useCallback(() => {
    setOpen((value) => {
      if (!value) updatePosition();
      return !value;
    });
  }, [updatePosition]);

  useEffect(() => {
    if (!open) return undefined;
    updatePosition();
    const onScrollOrResize = () => updatePosition();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, updatePosition]);

  if (!text || text === term) return null;

  const bubble =
    open && pos
      ? createPortal(
          <span
            id={tipId}
            role="tooltip"
            className={`info-tip__bubble info-tip__bubble--portal${pos.flipBelow ? " info-tip__bubble--below" : ""}`}
            style={{ top: pos.flipBelow ? pos.bottom : pos.top, left: pos.left }}
          >
            {text}
          </span>,
          document.body
        )
      : null;

  return (
    <>
      <span
        className={`info-tip${open ? " info-tip--open" : ""}`}
        ref={ref}
        onMouseEnter={show}
        onMouseLeave={close}
      >
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
      </span>
      {bubble}
    </>
  );
}
