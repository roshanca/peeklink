import 'react';

declare module 'react' {
  interface IframeHTMLAttributes<T> {
    /** Chrome's credentialless iframe mode; supported by the runtime but missing from React 18 types. */
    credentialless?: boolean;
  }
}
