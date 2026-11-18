# PeekLink v0.2.0

Chrome MV3 link-preview extension, macOS + Arc hybrid style.

## Requirements

- Node.js >= 22
- npm >= 10

## Start

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run build
npm run typecheck
```

Open `chrome://extensions`, enable Developer mode, then load `.output/chrome-mv3` after building.

## Upgrading from v0.1

Replace the source tree, remove old `node_modules`, `.wxt`, `.output`, and `package-lock.json`, then run `npm install`.

## Notes

- WXT 0.21.5, TypeScript 7.0.2, Vite 8.
- Uses `#imports` for WXT entrypoint definitions.
- Host permissions currently cover HTTP/HTTPS pages to fetch link metadata.
- Remote pages may block fetches or lack metadata.
- This is a development build, not a reviewed Chrome Web Store release.
