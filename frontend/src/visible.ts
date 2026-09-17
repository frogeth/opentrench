import { useEffect, useRef } from 'react';
import { api } from './api';

/**
 * Which tokens are on screen right now. Every card that shows a price registers its element; one
 * IntersectionObserver watches them all; the set goes to the backend (debounced, plus a heartbeat)
 * so the live pricer reads exactly the pools someone is looking at and nothing else.
 */
const HEARTBEAT_MS = 10_000;
const DEBOUNCE_MS = 400;
const clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
const onScreen = new Map<string, number>(); // address → how many visible elements show it
const addressOf = new WeakMap<Element, string>();
let timer: number | undefined;
let lastSent = '';

function send(force = false) {
  timer = undefined;
  const list = [...onScreen.keys()].sort();
  const key = list.join(',');
  if (!force && key === lastSent) return;
  lastSent = key;
  void api.setVisible(clientId, list).catch(() => {
    lastSent = ''; // try again on the next change or heartbeat
  });
}
function schedule() {
  if (timer !== undefined) return;
  timer = window.setTimeout(() => send(), DEBOUNCE_MS);
}
function mark(address: string, visible: boolean) {
  const n = onScreen.get(address) ?? 0;
  if (visible) onScreen.set(address, n + 1);
  else if (n <= 1) onScreen.delete(address);
  else onScreen.set(address, n - 1);
  schedule();
}
let observer: IntersectionObserver | undefined;
const shown = new WeakSet<Element>();
function io(): IntersectionObserver | undefined {
  if (typeof IntersectionObserver === 'undefined') return undefined;
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const a = addressOf.get(e.target);
          if (!a) continue;
          if (e.isIntersecting && !shown.has(e.target)) {
            shown.add(e.target);
            mark(a, true);
          } else if (!e.isIntersecting && shown.has(e.target)) {
            shown.delete(e.target);
            mark(a, false);
          }
        }
      },
      { rootMargin: '200px 0px' },
    );
    window.setInterval(() => send(true), HEARTBEAT_MS);
    document.addEventListener('visibilitychange', () => send(true));
  }
  return observer;
}

/** Attach to a card's root element: the token counts as on screen while the element is. */
export function useVisibleToken<T extends HTMLElement = HTMLDivElement>(address: string | undefined) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    const obs = io();
    if (!el || !address || !obs) return;
    addressOf.set(el, address);
    obs.observe(el);
    return () => {
      obs.unobserve(el);
      if (shown.has(el)) {
        shown.delete(el);
        mark(address, false);
      }
      addressOf.delete(el);
    };
  }, [address]);
  return ref;
}

/** A token that is on screen for as long as the component is mounted (the drill-down). */
export function useAlwaysVisible(address: string | undefined) {
  useEffect(() => {
    if (!address) return;
    io();
    mark(address, true);
    return () => mark(address, false);
  }, [address]);
}
