import { useState } from 'react';

export function Avatar({ src, name, size = 32, crown = false }: { src?: string; name: string; size?: number; crown?: boolean }) {
  const [broken, setBroken] = useState(false);
  const initial = (name.replace(/^@/, '')[0] ?? '?').toUpperCase();
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  const inner =
    !src || broken ? (
      <div className="avatar avatar-fallback" style={style}>
        {initial}
      </div>
    ) : (
      <img className="avatar" style={style} src={src} alt="" loading="lazy" onError={() => setBroken(true)} />
    );
  if (!crown) return inner;
  return (
    <span className="avatar-wrap" style={{ width: size, height: size }}>
      {inner}
      <span className="crown" style={{ fontSize: Math.max(10, Math.round(size * 0.45)) }} title="favorite caller">
        👑
      </span>
    </span>
  );
}
