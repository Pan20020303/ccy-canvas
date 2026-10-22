import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import MediaPreview from '../../src/app/components/MediaPreview';
import video from '../../src/imports/login-background.mp4';
const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="430" height="430"><rect width="430" height="430" fill="#21374b"/><circle cx="215" cy="180" r="110" fill="#ff783f"/><text x="215" y="365" text-anchor="middle" font-size="25" fill="white">430 × 430 · FIT TEST</text></svg>');
function Test() {
 const [kind, setKind] = useState<'image' | 'video' | 'broken' | null>(null);
 const [result, setResult] = useState('');
 return <><div style={{padding:30,display:'flex',gap:20}}>
  <button onClick={() => setKind('image')}>测试小图</button><button onClick={() => setKind('video')}>测试视频</button><button onClick={() => setKind('broken')}>测试加载失败</button><span>{result}</span>
 </div>{kind && <MediaPreview key={kind} kind={kind === 'video' ? 'video' : 'image'} src={kind === 'video' ? video : kind === 'broken' ? 'data:image/png;base64,AA==' : svg} title="预览交互测试" onClose={() => setKind(null)} onDownload={async () => { setResult('download'); }} onEdit={() => { setKind(null); setResult('edit'); }} onUpscale={() => { setKind(null); setResult('upscale'); }} />}</>;
}
createRoot(document.getElementById('root')!).render(<Test />);
