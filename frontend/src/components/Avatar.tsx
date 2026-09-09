import { useState } from 'react';

export function Avatar({ src, name, size = 32 }: { src?: string; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const initial = (name.replace(/^@/, '')[0] ?? '?').toUpperCase();
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (!src || broken)
    return (
      <div className="avatar avatar-fallback" style={style}>
        {initial}
      </div>
    );
  return <img className="avatar" style={style} src={src} alt="" loading="lazy" onError={() => setBroken(true)} />;
}
