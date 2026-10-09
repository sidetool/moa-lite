import type { createBrowserRouter } from 'react-router-dom';

export type RemotePreference = 'auto' | 'on' | 'off';
const tvBrowser = /SmartTV|Smart-TV|HbbTV|Tizen|Web0S|WebOS|GoogleTV|Android.*TV|\bAFT/i.test(navigator.userAgent);
let directionalInput = false;
export function remotePreference(): RemotePreference {
  try { const value = localStorage.getItem('moa.remoteMode'); return value === 'on' || value === 'off' ? value : 'auto'; } catch { return 'auto'; }
}
export function isRemoteMode() {
  const preference = remotePreference();
  return preference === 'on' || (preference === 'auto' && (tvBrowser || directionalInput));
}
function paintMode() { document.documentElement.toggleAttribute('data-tv', isRemoteMode()); }
export function setRemotePreference(value: RemotePreference) {
  try { localStorage.setItem('moa.remoteMode', value); } catch { /* private browsing */ }
  paintMode(); window.dispatchEvent(new Event('moa:remote-mode'));
}
export function remoteKey(event: KeyboardEvent): string {
  if (['Escape', 'BrowserBack', 'GoBack'].includes(event.key) || [10009, 461].includes(event.keyCode)) return 'Back';
  if (event.key === 'Select' || event.keyCode === 23) return 'Enter';
  const legacy: Record<number, string> = { 37:'ArrowLeft',38:'ArrowUp',39:'ArrowRight',40:'ArrowDown',13:'Enter',415:'MediaPlay',19:'MediaPause',10252:'MediaPlayPause',417:'MediaFastForward',412:'MediaRewind',413:'MediaStop' };
  return legacy[event.keyCode] || event.key;
}
export type RemotePlayerEvent = CustomEvent<{key: string; original: KeyboardEvent}>;
const selector = 'a[href],button,summary,input:not([type="hidden"]),select,textarea,[tabindex],[contenteditable="true"]';
const modalSelector = '[aria-modal="true"],[role="menu"],.player-panel';
function visible(el: HTMLElement) {
  if (!el.isConnected || el.closest('[hidden],[inert],[aria-hidden="true"]') || el.matches(":disabled")) return false;
  if (!el.getClientRects().length || el.closest('.player.is-idle .player-top,.player.is-idle .player-bottom')) return false;
  for (let p: HTMLElement | null = el; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
  }
  return true;
}
function items(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)].filter(el => visible(el) && (el.tabIndex >= 0 || el.hasAttribute('data-remote')) && !el.closest('[data-remote-skip]'));
}
function scope(): HTMLElement {
  return [...document.querySelectorAll<HTMLElement>(modalSelector)].filter(visible).at(-1) || document.querySelector<HTMLElement>('.player') || document.body;
}
function focus(el?: HTMLElement) {
  if (!el) return;
  el.focus({preventScroll: true});
  el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
}
function identity(el: HTMLElement) {
  return el.dataset.remoteId || el.id || `${el.tagName}:${el.getAttribute('href') || ''}:${el.getAttribute('aria-label') || el.textContent?.trim().slice(0,100) || el.getAttribute('name') || ''}`;
}
const selected = '[aria-current="true"],[aria-current="page"],[aria-selected="true"],[aria-pressed="true"],[role="menuitemradio"][aria-checked="true"],.is-current,.opt.is-active';
const groupSelector = '[data-remote-group],[role="tablist"],[role="radiogroup"]';
/** Entering a group from outside lands on its entry point or current choice, not whichever item happens to be closest. */
function entryOf(el: HTMLElement, from: HTMLElement, candidates: HTMLElement[]) {
  const group = el.closest<HTMLElement>(groupSelector);
  if (!group || group.contains(from)) return el;
  return candidates.find(c => group.contains(c) && c.matches('[data-remote-entry]'))
    || candidates.find(c => group.contains(c) && c.matches(selected)) || el;
}
function nearest(from: HTMLElement, candidates: HTMLElement[], key: string, loose: boolean) {
  const a = from.getBoundingClientRect(), horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  const sign = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  const ax = (a.left+a.right)/2, ay = (a.top+a.bottom)/2;
  const row = from.closest('.row-track'), card = from.closest('.card');
  const ahead: {el: HTMLElement; gap: number; overlap: number; cost: number}[] = [];
  for (const el of candidates) {
    if (el === from || (horizontal && row && !row.contains(el))) continue;
    // A card's secondary button is only a stop when moving within that card.
    if (el.hasAttribute('data-remote-secondary') && (horizontal || !card?.contains(el))) continue;
    const b = el.getBoundingClientRect(), bx = (b.left+b.right)/2, by = (b.top+b.bottom)/2;
    if ((horizontal ? bx-ax : by-ay)*sign < 2) continue;
    const gap = Math.max(0, horizontal ? (sign > 0 ? b.left-a.right : a.left-b.right) : (sign > 0 ? b.top-a.bottom : a.top-b.bottom));
    const overlap = horizontal ? Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top) : Math.min(a.right,b.right)-Math.max(a.left,b.left);
    // Side distance between edges, so a wide item next to a narrow one still counts as aligned.
    const side = overlap > 0 ? Math.abs(horizontal ? by-ay : bx-ax) : -overlap;
    ahead.push({el, gap, overlap, cost: gap + side*2});
  }
  // Outside a card row, left/right stays on the same line; otherwise a full-width list row would jump to the header.
  let pool = horizontal && !loose && !row ? ahead.filter(c => c.overlap > 0) : ahead;
  // The fixed header sits over scrolled content, so it is only reached when nothing on the page lies that way.
  const page = pool.filter(c => !c.el.closest('[data-remote-edge]') || from.closest('[data-remote-edge]'));
  if (page.length) pool = page;
  if (!pool.length) return undefined;
  // Up/down goes to the closest line first, then the best-aligned item on it.
  const line = horizontal ? Infinity : Math.min(...pool.map(c => c.gap)) + 24;
  const near = pool.filter(c => c.gap <= line);
  const aligned = near.filter(c => c.overlap > 0);
  const best = (aligned.length ? aligned : near).reduce((x, y) => y.cost < x.cost ? y : x).el;
  return entryOf(best, from, candidates);
}

/** One controller shared by all routes; playback consumes its own remote actions. */
export function installRemoteNavigation(router: ReturnType<typeof createBrowserRouter>) {
  paintMode();
  let currentKey = router.state.location.key;
  const remembered = new Map<string, {id: string; y: number}>();
  let restore: {id:string;y:number} | undefined;
  let lastScope: HTMLElement = document.body;
  let lastActivation: HTMLElement | undefined;
  let restoreUntil=0;
  const openers = new WeakMap<HTMLElement, HTMLElement>();
  let timer = 0;
  let forwardingEscape = false;
  // True while focus was placed by us; a better initial target that renders later may then take over.
  let autoFocused = false;
  const initial = ['[data-remote-initial]', '.center-play', '.hero-actions button', '.title-actions button'];
  const preferred = (choices: HTMLElement[]) => initial.map(sel => choices.find(el => el.matches(sel))).find(Boolean);
  const remember = () => {
    const el = document.activeElement as HTMLElement;
    if (el && el !== document.body && !el.closest(modalSelector)) {
      remembered.set(currentKey,{id:identity(el),y:window.scrollY});
      if (remembered.size > 80) remembered.delete(remembered.keys().next().value!);
    }
  };
  const sync = () => {
    if (!isRemoteMode()) return;
    const root = scope(), active = document.activeElement as HTMLElement;
    if (root !== lastScope) {
      if (root.matches(modalSelector)) {
        const opener = lastActivation?.isConnected ? lastActivation : active;
        if (opener && opener !== document.body && !root.contains(opener)) openers.set(root,opener);
        if (!items(root).includes(active)) { focus(items(root).find(el=>el.matches(selected)) || items(root)[0]); autoFocused=false; }
      } else {
        const opener = openers.get(lastScope);
        if (opener && visible(opener)) focus(opener);
      }
      lastScope = root;
    }
    const choices = items(root);
    if (Date.now()>restoreUntil) restore=undefined;
    if (restore) {
      const target = choices.find(el=>identity(el)===restore!.id);
      if (target) { window.scrollTo(0,restore.y); restore=undefined; focus(target); autoFocused=false; return; }
    }
    if (!root.contains(document.activeElement) || document.activeElement === document.body || !visible(document.activeElement as HTMLElement)) {
      focus(preferred(choices) || choices[0]); autoFocused=true;
    } else if (autoFocused) {
      const better = preferred(choices);
      if (better && better !== document.activeElement) focus(better);
    }
  };
  const schedule = () => { window.clearTimeout(timer); timer=window.setTimeout(sync,40); };
  const unsubscribe = router.subscribe(state => {
    if (state.location.key === currentKey) return;
    currentKey=state.location.key; restore=remembered.get(currentKey); restoreUntil=Date.now()+8000;
    schedule();
  });
  const observer = new MutationObserver(schedule);
  observer.observe(document.getElementById('root')!,{childList:true,subtree:true});
  document.addEventListener('focusin',remember);
  document.addEventListener('click',remember,true);
  const pointer = () => { autoFocused=false; if (!tvBrowser && remotePreference()==='auto') { directionalInput=false; paintMode(); } };
  document.addEventListener('pointerdown',pointer,true);
  const onKey = (event: KeyboardEvent) => {
    if (forwardingEscape || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const key=remoteKey(event), arrow=key.startsWith('Arrow');
    const target=event.target instanceof HTMLElement ? event.target : document.activeElement as HTMLElement;
    const typing=target.matches('textarea,input:not([type="range"]):not([type="checkbox"]):not([type="radio"]),[contenteditable="true"]');
    if (remotePreference()==='auto' && !document.querySelector('.player') && arrow && !typing) { directionalInput=true; paintMode(); }
    if (!isRemoteMode()) return;
    if (arrow || key==='Enter') { restore=undefined; autoFocused=false; }
    const back=key==='Back' || (key==='Backspace' && !typing);
    if (!arrow && !back && key!=='Enter' && !key.startsWith('Media')) return;
    if (back && event.repeat) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (typing && !back && (key==='ArrowLeft'||key==='ArrowRight'||key==='Enter')) return;
    if (target.matches('select,[role="combobox"]') && (key==='ArrowUp'||key==='ArrowDown'||key==='Enter'||key==='Back')) return;
    if (target.matches('input[type="range"]') && (key==='ArrowLeft'||key==='ArrowRight')) { event.stopPropagation(); return; }
    const playerEvent: RemotePlayerEvent = new CustomEvent('moa:remote-key',{detail:{key:back?'Back':key,original:event},cancelable:true});
    window.dispatchEvent(playerEvent);
    if (playerEvent.defaultPrevented) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (back) {
      event.preventDefault();event.stopImmediatePropagation();
      if (typing) { target.blur(); return; }
      const root=scope();
      if (root.matches(modalSelector)) {
        const close=items(root).find(el=>/^(닫기|취소)$/.test(el.getAttribute('aria-label')||el.textContent?.trim()||''));
        if (close) close.click();
        else { forwardingEscape=true; document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); forwardingEscape=false; }
      } else if (window.history.state?.idx > 0) void router.navigate(-1);
      else if (!['/','/profiles'].includes(router.state.location.pathname)) void router.navigate('/',{replace:true});
      return;
    }
    if (arrow) {
      event.preventDefault();event.stopImmediatePropagation();
      const root=scope(), choices=items(root), active=document.activeElement as HTMLElement;
      if (!choices.includes(active)) { focus(choices[0]); return; }
      focus(nearest(active,choices,key,root.matches(modalSelector)));
    } else if (key==='Enter' && (!target.matches('input,textarea,select,[contenteditable="true"]') || target.matches('input[type="checkbox"],input[type="radio"]'))) {
      event.preventDefault();event.stopImmediatePropagation();
      if (event.repeat) return;
      const root=scope(), choices=items(root), active=document.activeElement as HTMLElement;
      if (choices.includes(active)) { lastActivation=active; active.click(); } else focus(choices[0]);
    }
  };
  window.addEventListener('keydown',onKey,true);
  window.addEventListener('moa:remote-mode',schedule);
  document.addEventListener('animationend',schedule);
  schedule();
  return () => { unsubscribe();observer.disconnect();document.removeEventListener('animationend',schedule);clearTimeout(timer);window.removeEventListener('keydown',onKey,true);window.removeEventListener('moa:remote-mode',schedule);document.removeEventListener('focusin',remember);document.removeEventListener('click',remember,true);document.removeEventListener('pointerdown',pointer,true); };
}
