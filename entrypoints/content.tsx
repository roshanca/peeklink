import { defineContentScript } from '#imports';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { PreviewCard } from '../components/PreviewCard';
import type { PreviewResponse } from '../lib/types';
import css from './preview.css?inline';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  main() {
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
    let active: HTMLAnchorElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupPosition: (() => void) | undefined;
    let requestId = 0;
    let hoveringPopup = false;

    function clearTimers() { clearTimeout(timer); clearTimeout(closeTimer); }
    function close() {
      clearTimers();
      requestId++;
      cleanupPosition?.(); cleanupPosition = undefined;
      popup.style.display = 'none';
      active = null;
    }
    function scheduleClose() {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => { if (!hoveringPopup) close(); }, 180);
    }
    function render(url: string, state: { loading: boolean; response?: PreviewResponse }) {
      const response = state.response;
      root.render(<PreviewCard url={url} loading={state.loading} data={response?.ok ? response.data : undefined} error={response && !response.ok ? response.error : undefined} />);
    }
    async function show(link: HTMLAnchorElement) {
      if (!link.isConnected || active !== link) return;
      const url = link.href;
      const id = ++requestId;
      popup.style.display = 'block';
      render(url, { loading: true });
      cleanupPosition?.();
      const update = async () => {
        if (!link.isConnected) { close(); return; }
        const pos = await computePosition(link, popup, { strategy: 'fixed', placement: 'bottom-start', middleware: [offset(12), flip({ padding: 16 }), shift({ padding: 16 })] });
        Object.assign(popup.style, { left: `${pos.x}px`, top: `${pos.y}px` });
      };
      cleanupPosition = autoUpdate(link, popup, () => { void update(); });
      try {
        const response = await chrome.runtime.sendMessage({ type: 'PEEKLINK_PREVIEW', url }) as PreviewResponse;
        if (id !== requestId || active !== link) return;
        render(url, { loading: false, response });
        void update();
      } catch {
        if (id === requestId) render(url, { loading: false, response: { ok: false, error: 'Could not load this link.' } });
      }
    }
    document.addEventListener('pointerover', event => {
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest('a[href]') as HTMLAnchorElement | null;
      if (!link || link === active) { if (link === active) clearTimeout(closeTimer); return; }
      let url: URL;
      try { url = new URL(link.href); } catch { return; }
      if (!['http:', 'https:'].includes(url.protocol)) return;
      clearTimers();
      if (active) close();
      active = link;
      timer = setTimeout(() => { void show(link); }, 500);
    }, true);
    document.addEventListener('pointerout', event => {
      if (!active) return;
      const from = event.target;
      const to = event.relatedTarget;
      if (from instanceof Node && active.contains(from) && !(to instanceof Node && active.contains(to))) scheduleClose();
    }, true);
    popup.addEventListener('pointerenter', () => { hoveringPopup = true; clearTimeout(closeTimer); });
    popup.addEventListener('pointerleave', () => { hoveringPopup = false; scheduleClose(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); }, true);
    document.addEventListener('scroll', () => { if (active && !active.isConnected) close(); }, true);
  },
});
