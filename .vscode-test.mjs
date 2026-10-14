import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	mocha: {
		// Lifecycle race tests deliberately wait past short idle timeouts and
		// drive real HTTP, so they need more than the 2s default. Outcomes are
		// asserted deterministically rather than with retries.
		timeout: 20000
	}
});
