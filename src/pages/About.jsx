import { useI18n } from "../i18n/langStore";
import { useStaggerReveal } from "../hooks/useAnimations";

const GITHUB = "https://github.com/Fardinmilani";
const AVATAR = "https://github.com/Fardinmilani.png";
const STACK = ["React", "Vite", "GSAP", "Lightweight Charts", "Cloudflare Pages", "CoinGecko"];

export default function About() {
  const { t } = useI18n();
  const reveal = useStaggerReveal([]);

  return (
    <div className="about-page" ref={reveal}>
      <div className="about-card glass-card reveal">
        <div className="about-glow" aria-hidden="true" />
        <img className="about-avatar" src={AVATAR} alt={t("about.name")} width="96" height="96" loading="lazy" />
        <span className="about-role">{t("about.role")}</span>
        <h1 className="about-name">{t("about.name")}</h1>
        <p className="about-bio">{t("about.bio")}</p>
        <p className="about-tagline">{t("about.tagline")}</p>

        <a className="about-github" href={GITHUB} target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
            <path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.6v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.6 18.3 5 18.3 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z" />
          </svg>
          <span>{t("about.github")}</span>
        </a>

        <div className="about-stack">
          <span className="about-stack__label">{t("about.stack")}</span>
          <div className="about-stack__chips">
            {STACK.map((s) => (
              <span className="about-chip" key={s}>{s}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
