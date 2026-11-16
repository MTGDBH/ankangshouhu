// Public page URLs remain stable while frontend source files are grouped by version.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const router = express.Router();
const pages = new Map([
  ...['mobile', 'family'].map(name => [name, `app/${name}.html`]),
  ...['login', 'register'].map(name => [name, `auth/${name}.html`]),
  ...['showcase', 'dev'].map(name => [name, `demo/${name}.html`]),
  ...['agent', 'alerts', 'assessment', 'care', 'confidence', 'index',
    'intervention', 'knowledge', 'metric', 'monitoring', 'prediction',
    'privacy', 'profile', 'settings'].map(name => [name, `desktop/${name}.html`]),
]);

function sendPage(name, res) {
  const relative = pages.get(name);
  if (!relative) return res.status(404).type('text/plain').send('Not Found');
  return res.sendFile(path.join(repoRoot, 'frontend', relative));
}

router.get('/login', (_req, res) => res.redirect('/login.html'));
router.get('/mobile', (_req, res) => sendPage('mobile', res));
router.get('/family', (_req, res) => sendPage('family', res));
router.get('/', (req, res) => res.redirect(
  req.user?.role === 'caregiver' || req.user?.role === 'doctor' ? '/family' : '/mobile',
));
router.get('/:page.html', (req, res) => sendPage(req.params.page, res));

// Only browser assets are public; frontend source paths and the rest of the
// repository must never be served by a broad express.static(repoRoot).
router.use('/assets', express.static(path.join(repoRoot, 'assets'), { index: false }));
router.use('/截图', express.static(path.join(repoRoot, '截图'), { index: false }));
router.use((req, res, next) => {
  if (req.path === '/api' || req.path.startsWith('/api/')) return next();
  return res.status(404).type('text/plain').send('Not Found');
});

export default router;
