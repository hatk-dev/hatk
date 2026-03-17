import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Hatk',
  description: 'Build AT Protocol applications from scratch.',

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/getting-started/quickstart' },
      { text: 'CLI', link: '/cli/' },
      { text: 'API', link: '/api/' },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Quickstart', link: '/getting-started/quickstart' },
          { text: 'Project Structure', link: '/getting-started/project-structure' },
          { text: 'Configuration', link: '/getting-started/configuration' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Frontend (SvelteKit)', link: '/guides/frontend' },
          { text: 'API Client', link: '/guides/api-client' },
          { text: 'OAuth', link: '/guides/oauth' },
          { text: 'Feeds', link: '/guides/feeds' },
          { text: 'XRPC Handlers', link: '/guides/xrpc-handlers' },
          { text: 'Labels', link: '/guides/labels' },
          { text: 'Seeds', link: '/guides/seeds' },
          { text: 'OpenGraph Images', link: '/guides/opengraph' },
          { text: 'Hooks', link: '/guides/hooks' },
          { text: 'Deployment', link: '/guides/deployment' },
        ],
      },
      {
        text: 'CLI Reference',
        items: [
          { text: 'Overview', link: '/cli/' },
          { text: 'Scaffolding', link: '/cli/scaffold' },
          { text: 'Development', link: '/cli/development' },
          { text: 'Testing', link: '/cli/testing' },
          { text: 'Build & Deploy', link: '/cli/build' },
        ],
      },
      {
        text: 'API Reference',
        items: [
          { text: 'Overview', link: '/api/' },
          { text: 'Records', link: '/api/records' },
          { text: 'Feeds', link: '/api/feeds' },
          { text: 'Search', link: '/api/search' },
          { text: 'Blobs', link: '/api/blobs' },
          { text: 'Preferences', link: '/api/preferences' },
          { text: 'Labels', link: '/api/labels' },
        ],
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/bigmoves/atconf-workshop' }],
  },
})
