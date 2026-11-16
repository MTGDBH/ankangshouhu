import { readFileSync } from 'node:fs';

const template = readFileSync(new URL('../../../frontend/index.html', import.meta.url), 'utf8');
const shell = template.replace(/<!-- views -->[\s\S]*?<!-- end-views -->/, '<!-- view-body -->');
const layouts = {
  app: {
    styles: ['pro-tailwind.css', 'fontawesome.min.css', 'pro-charts.css'],
    scripts: ['pro-core.js', 'pro-charts.js', 'pro-voice-summary.js'],
  },
  auth: {
    styles: ['pro-auth.css'],
    scripts: ['pro-core.js', 'pro-auth.js'],
  },
  desktop: {
    styles: ['desktop-base.css', 'pro-legacy.css'],
    scripts: ['api.js', 'auth.js', 'desktop-ui.js'],
  },
};

const pages = new Map();
const viewPattern = /^<template data-view="([a-z-]+)" data-layout="([a-z-]+)"([^>]*)>\r?\n([\s\S]*?)^<\/template>$/gm;
for (const [, name, layoutName, bodyAttributes, view] of template.matchAll(viewPattern)) {
  const layout = layouts[layoutName];
  const [head, content] = view.split('<!-- view-content -->');
  if (!layout || !content || pages.has(name)) throw new Error(`Invalid frontend view: ${name}`);

  const styles = layout.styles.map(file => `<link rel="stylesheet" href="/assets/css/${file}">`).join('\n');
  const scripts = layout.scripts.map(file => `<script src="/assets/js/${file}"></script>`).join('\n');
  const viewport = head.includes('name="viewport"') ? '' : '<meta name="viewport" content="width=device-width, initial-scale=1">\n';
  const pageHead = viewport + head.replace('<!-- shared-styles -->', styles).trim();
  const pageBody = content.replace('<!-- shared-scripts -->', scripts).trim();
  pages.set(name, shell
    .replace('<body>', () => `<body${bodyAttributes}>`)
    .replace('<!-- view-body -->', () => pageBody)
    .replace(/<!-- view-head -->[\s\S]*?<!-- end-view-head -->/, () => pageHead));
}

export function renderPage(name) {
  return pages.get(name);
}
