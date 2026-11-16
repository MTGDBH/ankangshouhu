import express from 'express';
import { fileURLToPath } from 'node:url';
import { renderPage } from '../lib/renderPage.js';

const assetRoot = fileURLToPath(new URL('../../../frontend/assets/', import.meta.url));
const router = express.Router();

function sendPage(name, res) {
  const html = renderPage(name);
  if (!html) return res.status(404).type('text/plain').send('Not Found');
  return res.type('html').send(html);
}

router.get('/login', (_req, res) => res.redirect('/login.html'));
router.get('/mobile', (_req, res) => sendPage('mobile', res));
router.get('/family', (_req, res) => sendPage('family', res));
router.get('/', (req, res) => res.redirect(
  req.user?.role === 'caregiver' || req.user?.role === 'doctor' ? '/family' : '/mobile',
));
router.get('/:page.html', (req, res) => sendPage(req.params.page, res));

router.get('/assets/css/styles.css', (_req, res) => res.sendFile('css/desktop-base.css', { root: assetRoot }));
router.get('/assets/js/main.js', (_req, res) => res.sendFile('js/desktop-ui.js', { root: assetRoot }));
router.use('/assets', express.static(assetRoot, { index: false }));
router.use((req, res, next) => {
  if (req.path === '/api' || req.path.startsWith('/api/')) return next();
  return res.status(404).type('text/plain').send('Not Found');
});

export default router;
