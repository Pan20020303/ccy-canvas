import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";

import { SHOWCASE_INTERVAL_MS, showcaseScenes, type ShowcaseScene } from "./showcase-scenes";

export function AuthShowcase({ zh }: { zh: boolean }) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [reduceMotion, setReduceMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const controlsRef = useRef<HTMLDivElement>(null);
  const pointerFocus = useRef(false);
  const clock = useRef({ scene: 0, remaining: SHOWCASE_INTERVAL_MS });
  const gestureStart = useRef<{ x: number; y: number } | null>(null);
  const playing = !paused && !reduceMotion && !hidden;
  const rotating = playing && !focused && !hovered;
  const scene = showcaseScenes[active];

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onPreference = () => setReduceMotion(preference.matches);
    const onVisibility = () => setHidden(document.hidden);
    preference.addEventListener("change", onPreference);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      preference.removeEventListener("change", onPreference);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    if (clock.current.scene !== active) clock.current = { scene: active, remaining: SHOWCASE_INTERVAL_MS };
    if (!rotating) return;
    const started = performance.now();
    const timer = window.setTimeout(() => setActive((current) => (current + 1) % showcaseScenes.length), clock.current.remaining);
    return () => {
      window.clearTimeout(timer);
      clock.current.remaining = Math.max(0, clock.current.remaining - (performance.now() - started));
    };
  }, [active, rotating]);

  const move = (step: number) => setActive((current) => (current + step + showcaseScenes.length) % showcaseScenes.length);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    pointerFocus.current = false;
    let next: number;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (active + 1) % showcaseScenes.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (active - 1 + showcaseScenes.length) % showcaseScenes.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = showcaseScenes.length - 1;
    else return;
    event.preventDefault();
    setActive(next);
    controlsRef.current?.querySelectorAll<HTMLButtonElement>("[data-scene-button]")[next]?.focus();
  };

  return (
    <section
      className="auth-showcase" role="region" aria-roledescription={zh ? "轮播" : "carousel"}
      aria-label={zh ? "创作灵感轮播" : "Creative inspiration"}
      data-playing={playing} data-rotating={rotating} data-scene={scene.id}
      onKeyDown={onKeyDown}
      onFocusCapture={() => { setFocused(!pointerFocus.current); pointerFocus.current = false; }}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) { setFocused(false); pointerFocus.current = false; } }}
      onPointerDown={(event) => {
        pointerFocus.current = true;
        if (event.pointerType === "touch") gestureStart.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={(event) => {
        const start = gestureStart.current;
        gestureStart.current = null;
        if (!start) return;
        const dx = event.clientX - start.x;
        if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(event.clientY - start.y) * 1.4) move(dx < 0 ? 1 : -1);
      }}
      onPointerCancel={() => { gestureStart.current = null; }}
    >
      <div className="auth-scene-layers" aria-hidden="true">
        {showcaseScenes.map((item, index) => (
          <SceneMedia key={item.id} scene={item} active={active === index} playing={playing} eager={index === 0} />
        ))}
        <div className="auth-scene-atmosphere" />
        <div className="auth-scene-shade" />
        <div className="auth-scene-edge" />
      </div>

      <div ref={controlsRef} className="auth-scene-dots" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)} aria-label={zh ? "选择创作画面" : "Choose a scene"}>
        {showcaseScenes.map((item, index) => (
          <button
            key={item.id} type="button" className="auth-scene-dot" data-scene-button
            aria-label={zh ? `切换到第 ${index + 1} 个画面：${item.title.zh}` : `Show scene ${index + 1}: ${item.title.en}`}
            aria-pressed={index === active} title={zh ? item.title.zh : item.title.en}
            onClick={() => setActive(index)}
          ><span /></button>
        ))}
      </div>

      <div className="auth-showcase-bottom">
        <div className="auth-scene-caption" key={scene.id} aria-live={rotating ? "off" : "polite"} aria-atomic="true">
          <p className="auth-scene-category">{zh ? scene.category : scene.category.split(" · ")[0]}</p>
          <h2>{zh ? scene.title.zh : scene.title.en}</h2>
          <p className="auth-scene-byline">{zh ? "从一个灵感，到每一帧精彩。" : "From your first idea to the final frame."}</p>
        </div>
        <div className="auth-playback" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
          <span className="auth-scene-count"><span>{String(active + 1).padStart(2, "0")}</span> / {String(showcaseScenes.length).padStart(2, "0")}</span>
          <button type="button" onClick={() => move(-1)} aria-label={zh ? "上一个画面" : "Previous scene"}><ChevronLeft size={16} /></button>
          {!reduceMotion && <button type="button" onClick={() => { setPaused((value) => !value); setFocused(false); }} aria-label={zh ? (paused ? "播放轮播" : "暂停轮播") : (paused ? "Play slideshow" : "Pause slideshow")} aria-pressed={paused}>
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </button>}
          <button type="button" onClick={() => move(1)} aria-label={zh ? "下一个画面" : "Next scene"}><ChevronRight size={16} /></button>
        </div>
      </div>
      <div className="auth-scene-progress" aria-hidden="true"><span key={active} /></div>
    </section>
  );
}

function SceneMedia({ scene, active, playing, eager }: { scene: ShowcaseScene; active: boolean; playing: boolean; eager: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoReady, setVideoReady] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (active && playing) {
      void video.play().catch(() => setVideoReady(false));
    } else {
      video.pause();
      if (!active) {
        video.currentTime = 0;
        setVideoReady(false);
      }
    }
    return () => video.pause();
  }, [active, playing]);

  return (
    <div className="auth-scene" data-active={active} data-kind={scene.video ? "video" : "image"} style={{ "--scene-position": scene.position } as CSSProperties}>
      <img className="auth-scene-image" src={scene.poster} alt="" loading={eager ? "eager" : "lazy"} fetchPriority={eager ? "high" : "auto"} decoding="async" draggable={false} />
      {scene.video && <video
        ref={videoRef} className="auth-scene-video" data-ready={videoReady}
        src={active ? scene.video : undefined} poster={scene.poster}
        muted loop playsInline preload="none" tabIndex={-1} disablePictureInPicture
        onPlaying={() => setVideoReady(true)} onError={() => setVideoReady(false)}
      />}
    </div>
  );
}
