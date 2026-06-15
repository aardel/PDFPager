/**
 * Fast preview rendering for grid/sidebar thumbnails used while sorting.
 * Renders at display size only — no retina supersampling.
 */

const MAX_CONCURRENT = 6;
let running = 0;
const waiters: Array<() => void> = [];

function pumpQueue(): void {
  if (running >= MAX_CONCURRENT || waiters.length === 0) return;
  const next = waiters.shift();
  if (next) next();
}

/** PDF.js scale for a thumb that will be shown at `fitScale` CSS pixels. */
export function thumbRenderScale(fitScale: number): number {
  return Math.min(Math.max(fitScale, 0.06), 1.2);
}

/** Cap concurrent pdf.js page renders so large files stay responsive. */
export function runThumbRender<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const exec = async () => {
      running++;
      // A render that hangs (heavy/encrypted page) must not hold its slot
      // forever — both the sidebar and grid share this queue, so a few stuck
      // renders would otherwise freeze all thumbnails. Free the slot after a
      // timeout; freeing is idempotent so a late settle doesn't double-count.
      let freed = false;
      const free = () => {
        if (freed) return;
        freed = true;
        running--;
        pumpQueue();
      };
      const timer = setTimeout(free, 10000);
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      } finally {
        clearTimeout(timer);
        free();
      }
    };
    if (running < MAX_CONCURRENT) exec();
    else waiters.push(exec);
  });
}

/** Fixed scale for narrow sidebar thumbnails (~120px wide). */
export const SIDEBAR_THUMB_SCALE = 0.2;
