import { useEffect, useRef, useState } from "react";
import { gsap } from "gsap";

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Staggered entrance reveal for the direct children carrying `.reveal`.
 * Re-runs whenever `deps` change (e.g. switching tabs / coins).
 */
export function useStaggerReveal(deps = []) {
  const ref = useRef(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const targets = root.querySelectorAll(".reveal");
    if (!targets.length) return;
    if (prefersReducedMotion()) {
      gsap.set(targets, { opacity: 1, y: 0 });
      return;
    }
    const ctx = gsap.context(() => {
      gsap.fromTo(
        targets,
        { opacity: 0, y: 18 },
        {
          opacity: 1,
          y: 0,
          duration: 0.5,
          ease: "power3.out",
          stagger: 0.06,
          clearProps: "transform",
        }
      );
    }, root);
    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

/** Tween a numeric value smoothly; respects reduced-motion. */
export function useCountUp(value, { duration = 0.9, decimals = 2 } = {}) {
  const [display, setDisplay] = useState(value);
  const prev = useRef(value);
  useEffect(() => {
    const from = prev.current;
    prev.current = value;
    if (prefersReducedMotion() || from === value || !Number.isFinite(value)) {
      setDisplay(value);
      return;
    }
    const obj = { v: from };
    const tween = gsap.to(obj, {
      v: value,
      duration,
      ease: "power2.out",
      onUpdate: () => setDisplay(Number(obj.v.toFixed(decimals))),
    });
    return () => tween.kill();
  }, [value, duration, decimals]);
  return display;
}
