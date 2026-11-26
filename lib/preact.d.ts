import 'preact';

declare module 'preact' {
  namespace JSX {
    interface IframeHTMLAttributes {
      /** Chrome's credentialless iframe mode; missing from Preact's types. */
      credentialless?: boolean;
    }
  }
}
