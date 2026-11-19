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
    expect(data.title).toBe('Example — page');
    expect(data.hostname).toBe('example.com');
    expect(data.favicon).toBe('https://www.example.com/favicon.ico');
  });

  it('decodes common named and numeric entities', () => {
    const data = parseMetadata(
      '<title>Tom &amp; Jerry &#8212; &#x41;dventure &hellip;</title>',
      'https://example.com',
    );
    expect(data.title).toBe('Tom & Jerry — Adventure …');
  });

  it('replaces invalid code points instead of failing the preview', () => {
    const data = parseMetadata(
      '<title>a &#x110000; &#X41; &#99999999; &#0; &#xD800; b</title>',
      'https://example.com',
    );
    expect(data.title).toBe('a � A � � � b');
  });

  it('decodes meta attributes once without unwrapping literal entities', () => {
    const data = parseMetadata(
      '<meta property="og:title" content="Literal &amp;copy; &amp;">',
      'https://example.com',
    );
    expect(data.title).toBe('Literal &copy; &');
  });

  it('decodes semicolon-less numeric references in attribute values', () => {
    const data = parseMetadata(
      '<meta property="og:image" content="/a?x=1&#38y=2">',
      'https://example.com',
    );
    expect(data.image).toBe('https://example.com/a?x=1&y=2');
  });

  it('rejects non-HTTP metadata images', () => {
    const data = parseMetadata('<meta property="og:image" content="javascript:alert(1)">', 'https://example.com');
    expect(data.image).toBeUndefined();
  });
});
