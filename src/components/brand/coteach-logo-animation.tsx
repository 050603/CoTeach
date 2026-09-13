"use client";

import { useEffect, useId, useRef } from "react";
import styles from "./coteach-logo-animation.module.css";

/** Entrance/exit and ambient light use separate CSS timelines; no React frames. */
export function CoTeachLogoAnimation({
  className = "",
  playback = "once",
}: {
  className?: string;
  playback?: "loop" | "once";
}) {
  const id = useId().replace(/:/g, "");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = root.current;
    if (!element || !("IntersectionObserver" in window)) return;
    // A route restored by React can reuse its DOM. Restart on route entry,
    // while ordinary intersection changes only pause/resume the current pose.
    delete element.dataset.started;
    delete element.dataset.running;

    let visible = false;
    const sync = () => {
      element.dataset.running = String(visible && !document.hidden);
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) element.dataset.started = "true";
      sync();
    }, { threshold: 0.25 });
    observer.observe(element);
    document.addEventListener("visibilitychange", sync);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return (
    <div ref={root} data-coteach-animation="" data-playback={playback} className={`${styles.root} ${className}`}>
      <svg
        className={styles.art}
        viewBox="0 0 900 320"
        role="img"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        focusable="false"
      >
        <title id={`${id}-title`}>CoTeach</title>
        <desc id={`${id}-description`}>
          两侧下层书页同时展开，两侧人物同时翻起，随后中央星星点亮，最后 Co 与 Teach 字标依次显现。
        </desc>
        <defs>
          <linearGradient id={`${id}-blue`} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#0754a0" />
            <stop offset="0.48" stopColor="#073b80" />
            <stop offset="1" stopColor="#062f70" />
          </linearGradient>
          <linearGradient id={`${id}-teal`} x1="1" y1="0" x2="0" y2="1">
            <stop stopColor="#08b7ae" />
            <stop offset="0.5" stopColor="#009b9e" />
            <stop offset="1" stopColor="#007980" />
          </linearGradient>
          <linearGradient id={`${id}-gold`} x1="0" y1="0" x2="0.7" y2="1">
            <stop stopColor="#ffda79" />
            <stop offset="0.55" stopColor="#ffbf42" />
            <stop offset="1" stopColor="#f3a725" />
          </linearGradient>
          <radialGradient id={`${id}-light`}>
            <stop stopColor="#ffd678" stopOpacity="0.48" />
            <stop offset="1" stopColor="#ffd678" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${id}-shadow`}>
            <stop stopColor="#244e75" stopOpacity="0.16" />
            <stop offset="1" stopColor="#244e75" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${id}-sheen`}>
            <stop stopColor="white" stopOpacity="0" />
            <stop offset="0.5" stopColor="white" stopOpacity="0.85" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </linearGradient>
          {/* The T overhangs the o above y=299; stepped clips separate the
              supplied letters without cutting the T or duplicating pixels. */}
          <clipPath id={`${id}-word-co`}>
            <path d="M682 220H1090V299H1140V500H682Z" />
          </clipPath>
          <clipPath id={`${id}-word-teach`}>
            <path d="M1090 220H1982V500H1140V299H1090Z" />
          </clipPath>
          <mask id={`${id}-word-ink`} maskUnits="userSpaceOnUse" x="682" y="220" width="1300" height="280" style={{ maskType: "alpha" }}>
            <image href="/brand/coteach/horizontal-color.png" width="2048" height="683" />
          </mask>
        </defs>

        <g data-coteach-part="lockup" className={styles.lockup}>
          <ellipse className={styles.shadow} cx="160" cy="286" rx="140" ry="12" fill={`url(#${id}-shadow)`} />
          <g transform="translate(10 28)">
            <g data-coteach-part="pages" className={styles.pages}>
              <g data-coteach-part="pages-left" fill={`url(#${id}-blue)`}>
                <path d="M18 156C70 152 116 172 146 220C111 187 70 178 19 182Q12 182 12 175V163Q12 157 18 156Z" />
                <path d="M21 189C77 181 119 205 150 241C112 216 68 207 25 211Q17 212 16 205L14 197Q12 190 21 189Z" />
              </g>
              <g data-coteach-part="pages-right" fill={`url(#${id}-teal)`}>
                <path d="M282 156C230 152 184 172 154 220C189 187 230 178 281 182Q288 182 288 175V163Q288 157 282 156Z" />
                <path d="M279 189C223 181 181 205 150 241C188 216 232 207 275 211Q283 212 284 205L286 197Q288 190 279 189Z" />
              </g>
            </g>
            <g data-coteach-part="figures" className={styles.figures}>
              <g data-coteach-part="teacher" fill={`url(#${id}-blue)`}>
                <path d="M57 63C29 94 28 126 59 144C99 163 127 180 145 210C144 166 117 136 88 114C68 99 60 83 57 63Z" />
                <circle cx="92" cy="59" r="24" />
              </g>
              <g data-coteach-part="partner">
                <g fill={`url(#${id}-teal)`}>
                  <path d="M243 63C271 94 272 126 241 144C201 163 173 180 155 210C156 166 183 136 212 114C232 99 240 83 243 63Z" />
                  <circle cx="208" cy="59" r="24" />
                </g>
                <g className={styles.nodes} fill="#f0fffc" stroke="#f0fffc" strokeWidth="2.6">
                  <path d="M217 132L243 109" fill="none" />
                  <circle cx="217" cy="132" r="6.5" />
                  <circle cx="243" cy="109" r="6.5" />
                </g>
                <g transform="translate(217 132)">
                  <circle className={styles.signal} r="4" fill="#fff2b6" />
                </g>
                <circle className={styles.nodeEcho} cx="243" cy="109" r="10" fill="none" stroke="#e3fffb" strokeWidth="1.5" />
              </g>
            </g>
            <g data-coteach-part="spark" className={styles.spark}>
              <circle data-coteach-ambient="star-light" className={styles.light} cx="150" cy="123" r="67" fill={`url(#${id}-light)`} />
              <g className={styles.sparkPulse}>
                <path d="M150 94C155 115 158 119 177 124C158 129 155 134 150 153C145 134 142 129 123 124C142 119 145 115 150 94Z" fill={`url(#${id}-gold)`} />
                <path className={styles.sparkGleam} d="M150 94C155 115 158 119 177 124C158 129 155 134 150 153C145 134 142 129 123 124C142 119 145 115 150 94Z" fill="#fff1b7" />
              </g>
              <g transform="translate(126 101)" fill={`url(#${id}-gold)`}>
                <path className={styles.moteLeft} d="M0-4L1.3-1.3L4 0L1.3 1.3L0 4L-1.3 1.3L-4 0L-1.3-1.3Z" />
              </g>
              <g transform="translate(175 101)" fill={`url(#${id}-gold)`}>
                <path className={styles.moteRight} d="M0-3L1-1L3 0L1 1L0 3L-1 1L-3 0L-1-1Z" />
              </g>
            </g>
            <g className={styles.rays} fill="none" stroke="#ffc55b" strokeWidth="2.5" strokeLinecap="round">
              <path d="M150 77V64M127 83L120 72M173 83L180 72" />
            </g>
          </g>
        </g>

        {/* Reuse the supplied wordmark, retaining its exact letterforms and colors. */}
        <g>
          <g data-coteach-part="word-co" className={styles.wordCo}>
            <svg x="330" y="135" width="540" height="116" viewBox="682 220 1300 280">
              <image href="/brand/coteach/horizontal-color.png" width="2048" height="683" clipPath={`url(#${id}-word-co)`} />
            </svg>
          </g>
          <g data-coteach-part="word-teach" className={styles.wordTeach}>
            <svg x="330" y="135" width="540" height="116" viewBox="682 220 1300 280">
              <image href="/brand/coteach/horizontal-color.png" width="2048" height="683" clipPath={`url(#${id}-word-teach)`} />
            </svg>
          </g>
          <svg x="330" y="135" width="540" height="116" viewBox="682 220 1300 280">
            <g data-coteach-part="word-effects" className={styles.wordEffects} mask={`url(#${id}-word-ink)`}>
              <path data-coteach-ambient="word-glint" className={styles.wordGlint} d="M620 220H780L650 500H490Z" fill={`url(#${id}-sheen)`} />
            </g>
          </svg>
        </g>
      </svg>
    </div>
  );
}
