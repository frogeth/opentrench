import fs from 'node:fs';
import path from 'node:path';
import type { Snapshot } from './hub.js';

/**
 * JSON snapshot on disk, written at most once per `debounceMs` and on
 * shutdown. Written to a temp file then renamed so a crash mid-write never
 * leaves a truncated state file.
 */
export class StateStore {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: () => Snapshot;

  constructor(
    private file: string,
    private debounceMs = 2000,
  ) {}

  load(): Snapshot | undefined {
    try {
      const snap = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (snap?.version !== 1) return undefined;
      return snap as Snapshot;
    } catch (e: any) {
      if (e?.code !== 'ENOENT') console.warn('[state] could not load', this.file, e?.message ?? e);
      return undefined;
    }
  }

  schedule(get: () => Snapshot): void {
    this.pending = get;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.debounceMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const get = this.pending;
    this.pending = undefined;
    if (!get) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(get()), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e: any) {
      console.warn('[state] save failed', e?.message ?? e);
    }
  }
}
