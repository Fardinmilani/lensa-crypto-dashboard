import { useI18n } from "../i18n/langStore";
import { useStaggerReveal } from "../hooks/useAnimations";

const TOC = [
  ["map", "guide.toc.map"],
  ["workflow", "guide.toc.workflow"],
  ["best", "guide.toc.best"],
  ["validate", "guide.toc.validate"],
  ["decide", "guide.toc.decide"],
  ["stops", "guide.toc.stops"],
  ["leverage", "guide.toc.leverage"],
];

const MAP = [
  ["dashboard", "guide.map.dashboard.title", "guide.map.dashboard.body"],
  ["decision", "guide.map.decision.title", "guide.map.decision.body"],
  ["backtest", "guide.map.backtest.title", "guide.map.backtest.body"],
  ["edge", "guide.map.edge.title", "guide.map.edge.body"],
  ["forecast", "guide.map.forecast.title", "guide.map.forecast.body"],
  ["risk", "guide.map.risk.title", "guide.map.risk.body"],
];

const STEPS = ["s1", "s2", "s3", "s4", "s5", "s6"];
const BEST = ["b1", "b2", "b3", "b4", "b5", "b6"];
const VALIDATE = ["v1", "v2", "v3", "v4", "v5", "v6"];

export default function Guide() {
  const { t } = useI18n();
  const reveal = useStaggerReveal([]);

  function jump(id) {
    document.getElementById(`guide-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="guide-page" ref={reveal}>
      <section className="glass-card guide-hero reveal">
        <span className="panel-subtitle">{t("guide.kicker")}</span>
        <h1>{t("guide.title")}</h1>
        <p>{t("guide.lead")}</p>
        <nav className="guide-toc" aria-label={t("guide.kicker")}>
          {TOC.map(([id, key]) => (
            <button type="button" key={id} className="guide-toc__btn" onClick={() => jump(id)}>
              {t(key)}
            </button>
          ))}
        </nav>
      </section>

      <section className="glass-card guide-section reveal" id="guide-map">
        <h2>{t("guide.map.title")}</h2>
        <p>{t("guide.map.body")}</p>
        <div className="guide-map">
          {MAP.map(([id, title, body]) => (
            <article key={id} className="guide-map__card">
              <button type="button" className="guide-map__link" onClick={() => { window.location.hash = id; }}>
                {t(title)}
              </button>
              <p>{t(body)}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="glass-card guide-section reveal" id="guide-workflow">
        <h2>{t("guide.workflow.title")}</h2>
        <p>{t("guide.workflow.intro")}</p>
        <ol className="guide-steps">
          {STEPS.map((id) => (
            <li key={id}>
              <strong>{t(`guide.workflow.${id}.title`)}</strong>
              <span>{t(`guide.workflow.${id}.body`)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="glass-card guide-section reveal" id="guide-best">
        <h2>{t("guide.best.title")}</h2>
        <p>{t("guide.best.intro")}</p>
        <ul className="guide-list">
          {BEST.map((id) => (
            <li key={id}>{t(`guide.best.${id}`)}</li>
          ))}
        </ul>
      </section>

      <section className="glass-card guide-section reveal" id="guide-validate">
        <h2>{t("guide.validate.title")}</h2>
        <p>{t("guide.validate.intro")}</p>
        <ol className="guide-steps">
          {VALIDATE.map((id, i) => (
            <li key={id}>
              <strong>{i + 1}.</strong>
              <span>{t(`guide.validate.${id}`)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="glass-card guide-section guide-callout reveal" id="guide-decide">
        <h2>{t("guide.decide.title")}</h2>
        <p>{t("guide.decide.body")}</p>
      </section>

      <section className="glass-card guide-section reveal" id="guide-stops">
        <h2>{t("guide.stops.title")}</h2>
        <p>{t("guide.stops.body")}</p>
        <p className="guide-example">{t("guide.stops.example")}</p>
      </section>

      <section className="glass-card guide-section reveal" id="guide-leverage">
        <h2>{t("guide.leverage.title")}</h2>
        <p>{t("guide.leverage.body")}</p>
        <p className="guide-example">{t("guide.leverage.example")}</p>
      </section>

      <p className="guide-honest reveal">{t("guide.honest")}</p>
    </div>
  );
}
