import { useState } from 'react';

export function Avatar({ src, name }: { src?: string; name: string }) {
  const [broken, setBroken] = useState(false);
  const initial = (name.replace(/^@/, '')[0] ?? '?').toUpperCase();
  if (!src || broken) return <div className="avatar avatar-fallback">{initial}</div>;
  return <img className="avatar" src={src} alt="" loading="lazy" onError={() => setBroken(true)} />;
}
