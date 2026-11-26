import { renderToStaticMarkup } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { PreviewCard } from './PreviewCard';

describe('PreviewCard iframe security attributes', () => {
  it('renders credentialless and keeps an opaque-origin sandbox', () => {
    const markup = renderToStaticMarkup(<PreviewCard
      url="https://example.com/article"
      mode="webpage"
      loading={false}
      data={{
        url: 'https://example.com/article',
        hostname: 'example.com',
        title: 'Example',
        description: '',
      }}
      frame={{ embeddable: true }}
      onOpenSettings={() => undefined}
    />);

    expect(markup).toMatch(/credentialless(?=[\s/>])/);
    expect(markup).toContain('sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"');
    expect(markup).not.toContain('allow-same-origin');
  });
});
