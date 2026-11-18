import { defineUnlistedScript } from '#imports';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { PreviewCard } from '../components/PreviewCard';
import { DEFAULT_SETTINGS, getSettings, isWebsiteAllowed, normalizeSettings, type PeekSettings } from '../lib/settings';
import type { PreviewResponse } from '../lib/types';
import css from './link-preview.css?inline';

export default defineUnlistedScript(() => {
  if (document.getElementById('peeklink-root')) return;
  const host = document.createElement('div');
  host.id = 'peeklink-root';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = css;
  shadow.append(style);
  const popup = document.createElement('div');
  popup.className = 'peek-popup';
  popup.style.display = 'none';
  shadow.append(popup);
  document.documentElement.append(host);
  const root = createRoot(popup);

  let settings: PeekSettings | undefined;
  let active: HTMLAnchorElement | null = null;
  let hovered: HTMLAnchorElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupPosition: (() => void) | undefined;
  let requestId = 0;
  let hoveringPopup = false;

  void getSettings().then(value => { settings = value; }).catch(() => { settings = DEFAULT_SETTINGS; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !('settings' in changes)) return;
    settings = normalizeSettings(changes.settings.newValue);
    close();
  });

  function clearTimers() {
    clearTimeout(timer);
    clearTimeout(closeTimer);
  }

  function close() {
    clearTimers();
    requestId++;
    cleanupPosition?.();
    cleanupPosition = undefined;
    popup.style.display = 'none';
    root.render(null);
    active = null;
    hoveringPopup = false;
  }

  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (!hoveringPopup) close(); }, 180);
  }

  function render(url: string, state: { loading: boolean; response?: PreviewResponse }) {
    const response = state.response;
    root.render(<PreviewCard
      url={url}
      mode={settings?.mode ?? 'metadata'}
      loading={state.loading}
      data={response?.ok ? response.data : undefined}
      frame={response?.ok ? response.frame : undefined}
      error={response && !response.ok ? response.error : undefined}
      errorCode={response && !response.ok ? response.code : undefined}
      onOpenSettings={() => { void chrome.runtime.openOptionsPage(); }}
    />);
  }

  async function show(link: HTMLAnchorElement) {
    const currentSettings = settings;
    if (!link.isConnected || active !== link || !currentSettings || !isWebsiteAllowed(location.href, currentSettings)) return;
    const url = link.href;
    const id = ++requestId;
    popup.classList.toggle('peek-popup-webpage', currentSettings.mode === 'webpage');
    popup.style.display = 'block';
    render(url, { loading: true });
    cleanupPosition?.();
    const update = async () => {
      if (!link.isConnected) { close(); return; }
      const pos = await computePosition(link, popup, {
        strategy: 'fixed',
        placement: 'bottom-start',
        middleware: [offset(12), flip({ padding: 16 }), shift({ padding: 16 })],
      });
      Object.assign(popup.style, { left: `${pos.x}px`, top: `${pos.y}px` });
    };
    cleanupPosition = autoUpdate(link, popup, () => { void update(); });
    try {
      const response = await chrome.runtime.sendMessage({ type: 'PEEKLINK_PREVIEW', url }) as PreviewResponse;
      if (id !== requestId || active !== link) return;
      render(url, { loading: false, response });
      void update();
    } catch {
      if (id === requestId && active === link) {
        render(url, {
          loading: false,
          response: { ok: false, code: 'unavailable', error: 'Could not communicate with PeekLink. Reload the page or extension.' },
        });
      }
    }
  }

  function arm(link: HTMLAnchorElement, optionPressed: boolean) {
    if (!link.isConnected) return;
    if (link === active) { clearTimeout(closeTimer); return; }
    const currentSettings = settings;
    if (!currentSettings || !isWebsiteAllowed(location.href, currentSettings)) return;
    if (currentSettings.requireOption && !optionPressed) return;

    let url: URL;
    try { url = new URL(link.href); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol)) return;

    clearTimers();
    if (active) close();
    active = link;
    timer = setTimeout(() => { void show(link); }, currentSettings.delay);
  }

  document.addEventListener('pointerover', event => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const link = event.target.closest('a[href]') as HTMLAnchorElement | null;
    if (!link) return;
    hovered = link;
    arm(link, event.altKey);
  }, true);

  document.addEventListener('pointerout', event => {
    const from = event.target;
    const to = event.relatedTarget;
    if (hovered && from instanceof Node && hovered.contains(from) && !(to instanceof Node && hovered.contains(to))) {
      hovered = null;
    }
    if (!active) return;
    if (from instanceof Node && active.contains(from) && !(to instanceof Node && active.contains(to))) scheduleClose();
  }, true);

  document.addEventListener('keydown', event => {
    if (!event.isTrusted) return;
    if (event.key === 'Escape') close();
    if (event.key === 'Alt' && settings?.requireOption && hovered) arm(hovered, true);
  }, true);

  popup.addEventListener('pointerenter', () => { hoveringPopup = true; clearTimeout(closeTimer); });
  popup.addEventListener('pointerleave', () => { hoveringPopup = false; scheduleClose(); });
  document.addEventListener('scroll', () => { if (active && !active.isConnected) close(); }, true);
});
