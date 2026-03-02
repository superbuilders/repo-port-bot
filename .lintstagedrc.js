export default {
  "**/package.json": ["bunx sort-package-json", "oxfmt"],
  "*.{js,jsx,ts,tsx,svelte}": ["oxlint", "oxfmt"],
  "*.{json,md,yml}": ["oxfmt"],
  "*.{ts,tsx,json}": () => "knip-bun --no-progress",
};
