// Local review server only. Never deployed or used as the production entry point.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(script));
const port = Number(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port.');
const envFiles = (await readdir(root)).filter(n => n.startsWith('.env') && n !== '.env.example');
if (envFiles.length) throw new Error('Preview refuses to start alongside environment files.');

if (!process.argv.includes('--isolated-child')) {
  const child = spawn(process.execPath, [script, '--isolated-child', `--port=${port}`], {
    cwd: root,
    stdio: 'inherit',
    // No inherited service credentials, NODE_OPTIONS, analytics or production URLs.
    env: {
      RENOVATION_CATALOG_FILE: path.join(root, 'scripts/preview-bundle-catalog.json'),
      NODE_ENV: 'development', INVENTORY_BACKEND: 'file',
      CATALOG_CONFIG_BACKEND: 'file', PACKAGING_CONFIG_BACKEND: 'file',
      WAREHOUSE_CONFIG_BACKEND: 'file', PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    },
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const allowedEnv = new Set(['RENOVATION_CATALOG_FILE', 'NODE_ENV', 'INVENTORY_BACKEND', 'CATALOG_CONFIG_BACKEND',
    'PACKAGING_CONFIG_BACKEND', 'WAREHOUSE_CONFIG_BACKEND', 'PUBLIC_BASE_URL', '__CF_USER_TEXT_ENCODING']);
  if (Object.keys(process.env).some(k => !allowedEnv.has(k))) throw new Error('Unexpected preview environment.');
  globalThis.fetch = async () => { throw new Error('External requests are disabled in local review.'); };
  const { default: products } = await import('../api/products.js');
  const { default: productPage } = await import('../api/product-page.js');
  const { default: cartQuote } = await import('../api/cart-quote.js');
  const publicDir = path.join(root, 'public');
  const pages = new Set(['index.html', 'product.html', 'cart.html', 'checkout.html', 'contact.html', 'shipping.html', 'returns.html', 'privacy.html']);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.otf': 'font/otf', '.ico': 'image/x-icon' };
  const banner = '<aside style="padding:12px 20px;background:#fff2cb;color:#30260e;font:14px system-ui;text-align:center" role="status">Design review · Catalog snapshot · Sample stock · Payments and order submission disabled</aside>';
  function decorate(html) { return html.replace('</head>', '<meta name="saigoods-design-preview" content="checkout"></head>').replace(/(<body[^>]*>)/i, `$1${banner}`); }
  function adapter(res) {
    return {
      status(n) { res.statusCode = n; return this; },
      setHeader(k,v) { res.setHeader(k,v); return this; },
      json(body) { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(body)); },
      end(body = '') { res.end(typeof body === 'string' && body.includes('<body') ? decorate(body) : body); },
    };
  }
  createServer(async (req,res) => {
    res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy', "connect-src 'self'; form-action 'none'; frame-src 'none'");
    const out = adapter(res);
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const pathname = decodeURIComponent(url.pathname);
      if (req.method === 'GET' && pathname === '/api/analytics-config') return out.json({enabled:false,measurementId:null});
      if (req.method === 'GET' && pathname === '/api/products') return await products(req,out);
      if (req.method === 'POST' && ['/api/cart-quote','/api/cart/quote'].includes(pathname)) {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 128000) return out.status(413).json({error:'Request too large.'}); }
        return await cartQuote({method:'POST',body:JSON.parse(raw || '{}')},out);
      }
      if (pathname.startsWith('/api/') || pathname.startsWith('/admin') || (pathname.startsWith('/checkout') && pathname !== '/checkout.html') || !['GET','HEAD'].includes(req.method)) {
        return out.status(403).json({error:'This action is disabled in the local design review.'});
      }
      if (pathname === '/robots.txt') { res.setHeader('Content-Type','text/plain'); return res.end('User-agent: *\nDisallow: /\n'); }
      const match = pathname.match(/^\/products\/([^/]+)\/?$/);
      if (match) return await productPage({method:req.method,query:{slug:match[1],bundle:url.searchParams.get('bundle') || ''}},out);
      let relative = pathname.replace(/^\/+/, '') || 'index.html';
      if (['contact','shipping','returns','privacy'].includes(relative)) relative += '.html';
      if (!(pages.has(relative) || /^(js|css|img|font)\//.test(relative) || ['favicon.ico', 'favicon.svg'].includes(relative))) return out.status(404).end('Not found');
      const resolved = path.resolve(publicDir,relative);
      if (!resolved.startsWith(publicDir + path.sep)) return out.status(404).end('Not found');
      const extension = path.extname(resolved);
      if (!types[extension]) return out.status(404).end('Not found');
      const body = await readFile(resolved);
      res.setHeader('Content-Type',types[extension]);
      res.end(req.method === 'HEAD' ? '' : extension === '.html' ? decorate(body.toString()) : body);
    } catch (error) {
      out.status(error.code === 'ENOENT' ? 404 : 500).json({error:'Local preview could not serve this request.'});
      if (error.code !== 'ENOENT') console.error(error.message);
    }
  }).listen(port, '127.0.0.1', () => console.log(`Local design review: http://127.0.0.1:${port} (no service credentials)`));
}
