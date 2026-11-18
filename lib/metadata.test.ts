import { describe, expect, it } from 'vitest';
import { parseMetadata } from './metadata';

describe('parseMetadata', () => {
  it('parses Open Graph metadata and resolves relative assets', () => {
    const data = parseMetadata(`
      <html><head>
        <meta property="og:title" content="PeekLink &amp; previews" />
        <meta property="og:description" content="A quick preview" />
        <meta property="og:image" content="/assets/cover.png" />
        <link rel="shortcut icon" href="/favicon.png" />
      </head></html>
    `, 'https://example.com/articles/post');

    expect(data).toMatchObject({
      url: 'https://example.com/articles/post',
      hostname: 'example.com',
      title: 'PeekLink & previews',
      description: 'A quick preview',
      image: 'https://example.com/assets/cover.png',
      favicon: 'https://example.com/favicon.png',
    });
  });

  it('falls back to the title tag and default favicon', () => {
    const data = parseMetadata('<title>Example &mdash; page</title>', 'https://www.example.com/docs');
    expect(data.title).toBe('Example &mdash; page');
    expect(data.hostname).toBe('example.com');
    expect(data.favicon).toBe('https://www.example.com/favicon.ico');
  });

  it('rejects non-HTTP metadata images', () => {
    const data = parseMetadata('<meta property="og:image" content="javascript:alert(1)">', 'https://example.com');
    expect(data.image).toBeUndefined();
  });
});
