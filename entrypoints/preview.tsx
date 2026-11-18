import { defineUnlistedScript } from '#imports';
import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { PreviewCard } from '../components/PreviewCard';
import { canPreviewTarget, previewMediaSelector } from '../lib/preview-target';
import { getSettings, isWebsiteAllowed, normalizeSettings, type PeekSettings } from '../lib/settings';
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
  popup.hidden = true;
  popup.inert = true;
  shadow.append(popup);
  document.documentElement.append(host);
  const root = createRoot(popup);

  let settings: PeekSettings | undefined;
  let active: HTMLAnchorElement | null = null;
  let hovered: HTMLAnchorElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupPosition: (() => void) | undefined;
  let updatePosition: (() => Promise<void>) | undefined;
  let closing: { fade: Animation; resumableLink: HTMLAnchorElement | null } | undefined;
  let requestId = 0;
  let hoveringPopup = false;
  let optionHeld = false;

  void getSettings().then(value => { settings = value; }).catch(() => {
    settings = undefined;
    close();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !('settings' in changes)) return;
    settings = normalizeSettings(changes.settings.newValue);
    close();
  });

  function clearTimers() {
    clearTimeout(timer);
    clearTimeout(closeTimer);
  }

  function resetPopup() {
    requestId++;
    cleanupPosition?.();
    cleanupPosition = undefined;
    updatePosition = undefined;
    closing = undefined;
    popup.classList.remove('peek-popup-open');
    popup.inert = true;
    popup.hidden = true;
    root.render(null);
    hoveringPopup = false;
  }

  function revealPopup() {
    closing = undefined;
    popup.classList.add('peek-popup-open');
    popup.inert = false;
  }

  function close(resumable = false) {
    clearTimers();
    if (!resumable) {
      requestId++;
      active = null;
    }
    hoveringPopup = false;
    if (closing) {
      if (!resumable) closing.resumableLink = null;
      return;
    }

    popup.inert = true;
    popup.classList.remove('peek-popup-open');
    const fade = popup.getAnimations().find(animation =>
      animation instanceof CSSTransition && animation.transitionProperty === 'opacity');
    if (!fade) {
      active = null;
      resetPopup();
      return;
    }
    closing = { fade, resumableLink: active };
    const finish = () => {
      if (closing?.fade !== fade) return;
      if (active === closing.resumableLink) active = null;
      resetPopup();
    };
    void fade.finished.then(finish, finish);
  }

  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (!hoveringPopup) close(true); }, 180);
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
    if (currentSettings.requireOption && !optionHeld) { close(); return; }
    if (!canPreviewTarget(link, currentSettings.excludedTargets)) { close(); return; }
    if (closing) resetPopup();
    const url = link.href;
    const id = ++requestId;
    const isCurrent = () => id === requestId && active === link && link.isConnected && link.href === url;
    let positioned = false;
    let positionId = 0;
    const update = async () => {
      if (id !== requestId || closing) return;
      if (!link.isConnected) { close(); return; }
      const updateId = ++positionId;
      const pos = await computePosition(link, popup, {
        strategy: 'fixed',
        placement: 'bottom-start',
        middleware: [offset(12), flip({ padding: 16 }), shift({ padding: 16 })],
      });
      if (id !== requestId || updateId !== positionId || closing) return;
      Object.assign(popup.style, { left: `${pos.x}px`, top: `${pos.y}px` });
      popup.dataset.side = pos.placement.split('-')[0];
      if (!positioned) {
        positioned = true;
        revealPopup();
      }
    };
    popup.classList.toggle('peek-popup-webpage', currentSettings.mode === 'webpage');
    popup.hidden = false;
    flushSync(() => render(url, { loading: true }));
    updatePosition = update;
    cleanupPosition = autoUpdate(link, popup, () => { void update(); });

    let response: PreviewResponse;
    try {
      response = await chrome.runtime.sendMessage({ type: 'PEEKLINK_PREVIEW', url }) as PreviewResponse;
    } catch {
      response = { ok: false, code: 'unavailable', error: 'Could not communicate with PeekLink. Reload the page or extension.' };
    }
    if (!isCurrent()) return;
    if (!response.ok && response.code === 'not-html') {
      close();
      return;
    }
    render(url, { loading: false, response });
  }

  function arm(link: HTMLAnchorElement, optionPressed: boolean) {
    if (!link.isConnected) return;
    const currentSettings = settings;
    if (!currentSettings || !isWebsiteAllowed(location.href, currentSettings)) return;
    if (currentSettings.requireOption && !optionPressed) {
      if (link === active) close();
      return;
    }
    if (link === active) {
      clearTimeout(closeTimer);
      if (closing?.resumableLink === link) {
        revealPopup();
        void updatePosition?.();
      }
      return;
    }

    if (!canPreviewTarget(link, currentSettings.excludedTargets)) return;

    clearTimers();
    if (active) close();
    active = link;
    timer = setTimeout(() => { void show(link); }, currentSettings.delay);
  }

  document.addEventListener('pointerover', event => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    optionHeld = event.altKey;
    const link = event.target.closest('a[href]');
    if (!(link instanceof HTMLAnchorElement)) return;
    const media = event.target.closest(previewMediaSelector);
    if (media && link.contains(media)) {
      hovered = null;
      if (active === link) close();
      return;
    }
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
    if (from instanceof Node && active.contains(from) && !(to instanceof Node && active.contains(to))) {
      if (popup.classList.contains('peek-popup-open')) scheduleClose();
      else close();
    }
  }, true);

  document.addEventListener('keydown', event => {
    if (!event.isTrusted) return;
    if (event.key === 'Escape') close();
    if (event.key === 'Alt') {
      optionHeld = true;
      if (settings?.requireOption && hovered) arm(hovered, true);
    }
  }, true);

  document.addEventListener('keyup', event => {
    if (!event.isTrusted || event.key !== 'Alt') return;
    optionHeld = false;
    if (settings?.requireOption) close();
  }, true);

  window.addEventListener('blur', () => {
    optionHeld = false;
    if (settings?.requireOption) close();
  });

  popup.addEventListener('pointerenter', () => { hoveringPopup = true; clearTimeout(closeTimer); });
  popup.addEventListener('pointerleave', () => {
    hoveringPopup = false;
    if (popup.classList.contains('peek-popup-open')) scheduleClose();
  });
  document.addEventListener('scroll', () => { if (active && !active.isConnected) close(); }, true);
});
