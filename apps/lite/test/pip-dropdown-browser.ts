import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

// Keep React in the opener, as Document PiP does, while rendering into a smaller window.
const root = resolve(import.meta.dirname, '../../..');
const bundle = await build({
  stdin: { resolveDir: resolve(root, 'apps/web'), loader: 'tsx', contents: `
    import {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {Select} from './src/components/ui.tsx';
    function Example() {
      const [value, setValue] = useState('0');
      return <Select aria-label="Episode" value={value} onChange={setValue}
        options={Array.from({length: 12}, (_, i) => ({value: String(i), label: 'Episode ' + i}))} />;
    }
    document.querySelector('button').onclick = () => {
      const popup = window.open('about:blank', '', 'width=360,height=240');
      const css = popup.document.createElement('link');
      css.rel = 'stylesheet'; css.href = '/style.css'; popup.document.head.append(css);
      const host = popup.document.createElement('div'); host.style.marginTop = '170px';
      popup.document.body.append(host); createRoot(host).render(<Example />);
    };
  ` }, bundle: true, write: false, format: 'esm', jsx: 'automatic', define: { 'import.meta.env': '{}' },
});
const css = '* { box-sizing: border-box; }\n' + await readFile(resolve(root, 'apps/web/src/styles/components.css'), 'utf8');
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : req.url === '/style.css' ? 'text/css' : 'text/html');
  res.end(req.url === '/app.js' ? bundle.outputFiles[0].text : req.url === '/style.css' ? css : '<button>Open</button><script type="module" src="/app.js"></script>');
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  const opened = page.waitForEvent('popup'); await page.click('button');
  const popup = await opened, trigger = popup.getByRole('combobox');
  await trigger.click();
  const bounds = await popup.getByRole('listbox').evaluate(element => {
    const box = element.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: innerWidth, height: innerHeight };
  });
  assert(bounds.top >= 0 && bounds.bottom <= bounds.height && bounds.left >= 0 && bounds.right <= bounds.width, JSON.stringify(bounds));
  await popup.keyboard.press('End'); await popup.keyboard.press('Enter');
  assert.match(await trigger.textContent() ?? '', /Episode 11/);
  await trigger.click();
  await popup.waitForFunction(() => document.querySelector('[role="combobox"]')?.getAttribute('aria-expanded') === 'true');
  await popup.evaluate(() => window.dispatchEvent(new Event('resize')));
  await popup.waitForFunction(() => document.querySelector('[role="combobox"]')?.getAttribute('aria-expanded') === 'false');
  console.log('PASS PiP dropdown stays inside its own viewport, supports keyboard selection and closes on its window resize');
} finally {
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
