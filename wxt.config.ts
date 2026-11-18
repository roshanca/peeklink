import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'PeekLink',
    description: 'A beautiful, native-feeling link preview.',
    permissions: ['storage'],
    host_permissions: ['http://*/*', 'https://*/*'],
    action: { default_title: 'PeekLink' },
  },
});
