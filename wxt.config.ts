import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'PeekLink',
    description: 'A beautiful, native-feeling link preview.',
    icons: {
      16: 'icons/16.png',
      32: 'icons/32.png',
      48: 'icons/48.png',
      128: 'icons/128.png',
    },
    permissions: ['storage', 'scripting', 'webRequest'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    action: {
      default_title: 'PeekLink',
      default_icon: {
        16: 'icons/16.png',
        32: 'icons/32.png',
        48: 'icons/48.png',
        128: 'icons/128.png',
      },
    },
  },
});
