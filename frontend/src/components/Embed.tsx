import type { EmbedInfo } from '../types';
import { RichText } from './RichText';

/** A Discord rich embed, laid out the way Discord does: colour bar, author, title, description, fields grid, media, footer. */
export function Embed({ e, contracts }: { e: EmbedInfo; contracts: string[] }) {
  const title = e.title ? (
    e.url ? (
      <a href={e.url} target="_blank" rel="noreferrer">
        <RichText text={e.title} contracts={contracts} />
      </a>
    ) : (
      <RichText text={e.title} contracts={contracts} />
    )
  ) : null;
  return (
    <div className={`embed${e.thumbnail ? ' embed-has-thumb' : ''}`} style={e.color ? { borderLeftColor: e.color } : undefined}>
      <div className="embed-body">
        {e.author && (
          <div className="embed-author">
            {e.author.icon && <img src={e.author.icon} alt="" loading="lazy" />}
            {e.author.url ? (
              <a href={e.author.url} target="_blank" rel="noreferrer">
                {e.author.name}
              </a>
            ) : (
              <span>{e.author.name}</span>
            )}
          </div>
        )}
        {title && <div className="embed-title">{title}</div>}
        {e.description && (
          <div className="embed-desc">
            <RichText text={e.description} contracts={contracts} />
          </div>
        )}
        {e.fields.length > 0 && (
          <div className="embed-fields">
            {e.fields.map((f, i) => (
              <div key={i} className={`embed-field${f.inline ? ' inline' : ''}`}>
                {f.name && (
                  <div className="embed-fname">
                    <RichText text={f.name} contracts={contracts} />
                  </div>
                )}
                {f.value && (
                  <div className="embed-fval">
                    <RichText text={f.value} contracts={contracts} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {e.image && <img className="embed-image" src={e.image} alt="" loading="lazy" />}
        {e.footer && <div className="embed-footer">{e.footer}</div>}
      </div>
      {e.thumbnail && <img className="embed-thumb" src={e.thumbnail} alt="" loading="lazy" />}
    </div>
  );
}
