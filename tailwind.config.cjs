/* Config for the PRECOMPILED viewer stylesheet (src/tailwind.css).
   We embed Tailwind instead of the runtime Play CDN (cdn.tailwindcss.com), which is
   JavaScript that some iOS Safari private-browsing / content-blocker setups silently
   block — leaving the whole UI unstyled. Regenerate after changing any class:
     npm run build:css   (then npm run build)
   Pinned to 3.4.17 = the version the CDN was serving, so the rendered result is identical. */
module.exports = {
  content: ['docs/index.html', 'src/**/*.js', 'userscript/build.mjs'],
  theme: { extend: { colors: { gold: { DEFAULT: '#FF4500', dark: '#CC3700' } } } },
};
