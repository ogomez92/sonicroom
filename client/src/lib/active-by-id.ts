import { useState } from "react";

// The roving "active option" of a listbox, remembered by item id rather than
// by index: when a row above it disappears (a peer leaves, the chat history
// drops its oldest message) the same item stays active, so Enter / Ctrl+C
// never silently land on a different person or message. If the active item
// itself vanished, the nearest index takes over.
export interface ActiveItem {
  id: string;
  idx: number;
}

export function resolveActiveIndex(ids: readonly string[], active: ActiveItem | null): number {
  if (!active || ids.length === 0) return -1;
  const found = ids.indexOf(active.id);
  return found >= 0 ? found : Math.min(active.idx, ids.length - 1);
}

// Drop-in for `useState(-1)` on an index: returns [activeIdx, setActiveIdx]
// with the same number-or-updater setter. -1 = none yet.
export function useActiveById<T>(items: readonly T[], idOf: (item: T) => string) {
  const [active, setActive] = useState<ActiveItem | null>(null);
  const ids = items.map(idOf);
  const activeIdx = resolveActiveIndex(ids, active);
  // The active item vanished and a neighbour took over (or the list emptied):
  // re-attach to what is shown NOW, so it is followed by id from here on rather
  // than by the dead item's old index. Adjusting state during render is React's
  // pattern for state derived from props; it settles in one extra pass.
  const shownId = activeIdx >= 0 ? ids[activeIdx] : null;
  if (active && active.id !== shownId) {
    setActive(shownId == null ? null : { id: shownId, idx: activeIdx });
  }
  const setActiveIdx = (next: number | ((i: number) => number)) => {
    const n = typeof next === "function" ? next(activeIdx) : next;
    setActive(n >= 0 && n < items.length ? { id: idOf(items[n]), idx: n } : null);
  };
  return [activeIdx, setActiveIdx] as const;
}
