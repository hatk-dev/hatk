// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
	integrations: [
		starlight({
			title: 'Hatk',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/bigmoves/atconf-workshop' },
			],
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Quickstart', slug: 'getting-started/quickstart' },
						{ label: 'Project Structure', slug: 'getting-started/project-structure' },
						{ label: 'Configuration', slug: 'getting-started/configuration' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Frontend (SvelteKit)', slug: 'guides/frontend' },
						{ label: 'API Client', slug: 'guides/api-client' },
						{ label: 'OAuth', slug: 'guides/oauth' },
						{ label: 'Feeds', slug: 'guides/feeds' },
						{ label: 'XRPC Handlers', slug: 'guides/xrpc-handlers' },
						{ label: 'Labels', slug: 'guides/labels' },
						{ label: 'Seeds', slug: 'guides/seeds' },
						{ label: 'OpenGraph Images', slug: 'guides/opengraph' },
						{ label: 'Hooks', slug: 'guides/hooks' },
					],
				},
				{
					label: 'CLI Reference',
					items: [
						{ label: 'Overview', slug: 'cli' },
						{ label: 'Scaffolding', slug: 'cli/scaffold' },
						{ label: 'Development', slug: 'cli/development' },
						{ label: 'Testing', slug: 'cli/testing' },
						{ label: 'Build & Deploy', slug: 'cli/build' },
					],
				},
				{
					label: 'API Reference',
					items: [
						{ label: 'Overview', slug: 'api' },
						{ label: 'Records', slug: 'api/records' },
						{ label: 'Feeds', slug: 'api/feeds' },
						{ label: 'Search', slug: 'api/search' },
						{ label: 'Blobs', slug: 'api/blobs' },
						{ label: 'Preferences', slug: 'api/preferences' },
						{ label: 'Labels', slug: 'api/labels' },
					],
				},
			],
		}),
	],
});
