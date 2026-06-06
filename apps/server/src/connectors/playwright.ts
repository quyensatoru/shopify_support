import type { Browser } from 'playwright';
import { getEnv } from '../env.js';

type PageSignals = {
  title: string;
  status: number;
  html: string;
  scripts: string[];
  consoleErrors: string[];
  networkErrors: string[];
};

let _browser: Browser | undefined;

async function getBrowser(): Promise<Browser> {
  if (_browser) return _browser;
  const { chromium } = await import('playwright');
  _browser = await chromium.launch({ headless: getEnv().PLAYWRIGHT_HEADLESS });
  return _browser;
}

export async function renderPage(url: string): Promise<PageSignals> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'ShopifySupportAgent/1.0',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('requestfailed', (req) => {
    networkErrors.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? 'failed'}`);
  });

  let status = 0;
  try {
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 });
    status = response?.status() ?? 0;
  } catch {
    status = 0;
  }

  const title = await page.title().catch(() => '');
  const html = await page.content().catch(() => '');
  // String form avoids TS DOM-type errors (runs in browser context, not Node)
  const scripts = await page.evaluate<string[]>(
    `Array.from(document.querySelectorAll('script[src]')).map(function(s){return s.getAttribute('src')||''})`
  ).catch(() => [] as string[]);

  await context.close();

  return { title, status, html: html.slice(0, 50_000), scripts, consoleErrors, networkErrors };
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = undefined;
  }
}
