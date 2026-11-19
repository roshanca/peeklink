import { useEffect, useState } from 'react';
import { websiteOriginPattern } from '../../lib/permissions';
import { parseTargetRules } from '../../lib/preview-target';
import {
  DEFAULT_SETTINGS,
  getSettings,
  normalizeSettings,
  parseWebsiteRules,
  saveSettings,
  type PeekSettings,
} from '../../lib/settings';

const ALL_SITE_ORIGINS = ['http://*/*', 'https://*/*'];

export function Options() {
  const [settings, setSettings] = useState<PeekSettings>(DEFAULT_SETTINGS);
  const [allowlist, setAllowlist] = useState('');
  const [blocklist, setBlocklist] = useState('');
  const [excludedTargets, setExcludedTargets] = useState('');
  const [site, setSite] = useState('');
  const [origins, setOrigins] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  async function refreshPermissions() {
    const permissions = await chrome.permissions.getAll();
    setOrigins((permissions.origins ?? []).sort());
  }

  useEffect(() => {
    void getSettings().then(saved => {
      setSettings(saved);
      setAllowlist(saved.allowlist.join('\n'));
      setBlocklist(saved.blocklist.join('\n'));
      setExcludedTargets(saved.excludedTargets.join('\n'));
    }).catch(() => setError('Could not load settings.'));
    void refreshPermissions().catch(() => setError('Could not load website permissions.'));
    const sync = () => { void refreshPermissions().catch(() => undefined); };
    // @types/chrome omits removeListener on these event interfaces.
    const events = chrome.permissions as unknown as {
      onAdded: chrome.events.Event<() => void>;
      onRemoved: chrome.events.Event<() => void>;
    };
    events.onAdded.addListener(sync);
    events.onRemoved.addListener(sync);
    return () => {
      events.onAdded.removeListener(sync);
      events.onRemoved.removeListener(sync);
    };
  }, []);

  function update<Key extends keyof PeekSettings>(key: Key, value: PeekSettings[Key]) {
    setSettings(current => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setStatus('');
    setError('');
    try {
      const next = normalizeSettings({
        ...settings,
        allowlist: parseWebsiteRules(allowlist),
        blocklist: parseWebsiteRules(blocklist),
        excludedTargets: parseTargetRules(excludedTargets),
      });
      await saveSettings(next);
      setSettings(next);
      setAllowlist(next.allowlist.join('\n'));
      setBlocklist(next.blocklist.join('\n'));
      setExcludedTargets(next.excludedTargets.join('\n'));
      setStatus('Settings saved.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save settings.');
    }
  }

  function grantAllAccess() {
    setStatus('');
    setError('');
    // Keep the request synchronous within the click handler for Chrome's user gesture.
    void chrome.permissions.request({ origins: ALL_SITE_ORIGINS }).then(async granted => {
      if (!granted) {
        setError('Website access was not granted.');
        return;
      }
      setStatus('PeekLink is now enabled on all websites. Reload already-open tabs.');
      await refreshPermissions();
    }).catch(() => setError('Could not request website access.'));
  }

  function grantAccess() {
    const origin = websiteOriginPattern(site);
    setStatus('');
    setError('');
    if (!origin) {
      setError('Enter a valid website, for example example.com or https://example.com.');
      return;
    }

    // This must run directly in the click handler to preserve Chrome's user gesture.
    void chrome.permissions.request({ origins: [origin] }).then(async granted => {
      if (!granted) {
        setError('Website access was not granted.');
        return;
      }
      setSite('');
      setStatus(`Access granted for ${origin}`);
      await refreshPermissions();
    }).catch(() => setError('Could not request website access.'));
  }

  function revokeAccess(origin: string) {
    setStatus('');
    setError('');
    void chrome.permissions.remove({ origins: [origin] }).then(async removed => {
      if (!removed) {
        setError(`Access could not be removed for ${origin}`);
        await refreshPermissions();
        return;
      }
      setStatus(`Access removed for ${origin}`);
      await refreshPermissions();
    }).catch(() => setError('Could not remove website access.'));
  }

  return <main>
    <h1>PeekLink</h1>
    <p className="intro">Control when previews appear and which websites can be fetched.</p>

    <section>
      <h2>Website access</h2>
      <p>Enable all websites once for the simplest setup. You can still use allowlist and blocklist rules below. For granular control, grant individual origins instead.</p>
      <button type="button" onClick={grantAllAccess} disabled={ALL_SITE_ORIGINS.every(origin => origins.includes(origin))}>
        {ALL_SITE_ORIGINS.every(origin => origins.includes(origin)) ? 'Enabled on all websites' : 'Enable on all websites'}
      </button>
      <p>Reload already-open tabs after granting access. Removing access prevents future activations and metadata requests.</p>
      <h3>Or allow an individual website</h3>
      <div className="permission-form">
        <label className="field">Website
          <input type="text" value={site} onChange={event => setSite(event.target.value)} placeholder="example.com" />
        </label>
        <button type="button" onClick={grantAccess}>Allow website</button>
      </div>
      {origins.length > 0 && <ul className="permissions">
        {origins.map(origin => <li key={origin}>
          <span>{origin}</span>
          <button type="button" className="secondary" onClick={() => revokeAccess(origin)}>Remove</button>
        </li>)}
      </ul>}
    </section>

    <form onSubmit={event => void submit(event)}>
      <section>
        <h2>Preview trigger</h2>
        <label className="field">Preview mode
          <small>Webpage mode loads an interactive iframe when the destination allows it, and falls back to metadata otherwise.</small>
          <select value={settings.mode} onChange={event => update('mode', event.target.value as PeekSettings['mode'])}>
            <option value="metadata">Metadata card</option>
            <option value="webpage">Interactive webpage</option>
          </select>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={settings.requireOption} onChange={event => update('requireOption', event.target.checked)} />
          Require holding Option (Alt) while hovering
        </label>
        <label className="field">Trigger delay (milliseconds)
          <small>Use a longer delay to avoid requests during casual mouse movement. Maximum: 3000ms.</small>
          <input type="number" min="0" max="3000" step="50" value={settings.delay} onChange={event => update('delay', Number(event.target.value))} />
        </label>
      </section>

      <section>
        <h2>Website rules</h2>
        <p>Rules apply to the current page and include subdomains. The blocklist always wins. When the allowlist is not empty, all unlisted websites are disabled.</p>
        <label className="field">Allowlist
          <small>One hostname per line, for example developer.mozilla.org</small>
          <textarea value={allowlist} onChange={event => setAllowlist(event.target.value)} placeholder="Leave empty to allow all permitted websites" />
        </label>
        <label className="field">Blocklist
          <small>One hostname per line, for example social.example.com</small>
          <textarea value={blocklist} onChange={event => setBlocklist(event.target.value)} placeholder="No blocked websites" />
        </label>
        <label className="field">Excluded link destinations
          <small>One rule per line. Use example.com for a domain and its subdomains, example.com/subscribe for an exact path, or example.com/media/* for paths under a directory. Query strings and fragments are ignored.</small>
          <textarea value={excludedTargets} onChange={event => setExcludedTargets(event.target.value)} placeholder="example.com/media/*" />
        </label>
        <div className="actions">
          <button type="submit">Save settings</button>
          <p className={`status ${error ? 'error' : ''}`} role="status">{error || status}</p>
        </div>
      </section>
    </form>
  </main>;
}
