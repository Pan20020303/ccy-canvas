import { useEffect, useState } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import { showcaseScenes } from '../auth/showcase-scenes';

export function HomeBanners({ zh, onCreate, onGallery }: { zh: boolean; onCreate: () => void; onGallery: () => void }) {
  const [active, setActive] = useState(1);
  const [paused, setPaused] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => setReduced(media.matches);
    const visibility = () => setHidden(document.hidden);
    media.addEventListener('change', motion); document.addEventListener('visibilitychange', visibility);
    return () => { media.removeEventListener('change', motion); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useEffect(() => {
    if (paused || interacting || hidden || reduced) return;
    const timer = window.setTimeout(() => setActive(v => (v + 1) % 3), 7000);
    return () => window.clearTimeout(timer);
  }, [active, paused, interacting, hidden, reduced]);
  const banners = [
    { title: zh ? '一个灵感，无限种可能' : 'One idea. Infinite possibilities.', tag: 'INFINITE CANVAS', text: zh ? '把文字、图像与视频，连成你的创作世界' : 'Connect words, images and video.', action: onCreate },
    { title: zh ? '让故事，从这里发生' : 'Your next story starts here.', tag: 'CCY CREATIVE STUDIO', text: zh ? '从一个灵感，开启你的创作之旅' : 'From an idea to your creative world.', action: onCreate },
    { title: zh ? '每一帧，皆有无限可能' : 'Every frame, a possibility.', tag: 'MADE WITH IMAGINATION', text: zh ? '探索精选画布，找到属于你的灵感' : 'Discover canvases. Find your inspiration.', action: onGallery },
  ];
  return <section className="home-banners" aria-label={zh ? '创作推荐轮播' : 'Creative highlights'} aria-roledescription="carousel" onMouseEnter={() => setInteracting(true)} onMouseLeave={() => setInteracting(false)} onFocus={() => setInteracting(true)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setInteracting(false); }}>
    <div className="home-banner-stage">{banners.map((b, i) => {
      const position = (i - active + 3) % 3;
      return <button type="button" key={b.tag} className={`home-banner ${position === 0 ? 'is-center' : position === 1 ? 'is-next' : 'is-previous'}`} onClick={b.action} aria-label={b.title}>
        <img className="home-banner-art" src={showcaseScenes[i].poster} alt="" /><div className="home-banner-shade" />
        <div className="home-banner-copy"><small>{b.tag}</small><h2>{b.title}</h2><p>{b.text}</p></div><ArrowUpRight className="home-banner-link" size={20} />
      </button>;
    })}</div>
    <button className="home-banner-arrow is-left" type="button" onClick={() => setActive(v => (v + 2) % 3)} aria-label={zh ? '上一条推荐' : 'Previous highlight'}><ChevronLeft size={18} /></button>
    <button className="home-banner-arrow is-right" type="button" onClick={() => setActive(v => (v + 1) % 3)} aria-label={zh ? '下一条推荐' : 'Next highlight'}><ChevronRight size={18} /></button>
    <div className="home-banner-controls">{banners.map((_, i) => <button className={`home-banner-dot ${active === i ? 'is-active' : ''}`} key={i} type="button" aria-label={zh ? `切换到推荐 ${i + 1}` : `Go to highlight ${i + 1}`} aria-pressed={i === active} onClick={() => setActive(i)} />)}<button className="home-banner-pause" type="button" disabled={reduced} onClick={() => { if (paused) setInteracting(false); setPaused(!paused); }} aria-label={zh ? (paused ? '播放推荐轮播' : '暂停推荐轮播') : (paused ? 'Play highlights' : 'Pause highlights')}>{paused || reduced ? <Play size={11} /> : <Pause size={11} />}</button></div>
  </section>;
}
