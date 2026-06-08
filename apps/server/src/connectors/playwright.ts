import type { Browser } from 'playwright';
import { getEnv } from '../env.js';

export type PageSignals = {
    title: string;
    status: number;
    html: string;
    scripts: string[];
    consoleErrors: string[];
    networkErrors: string[];
    responseHeaders: Record<string, string>;
};

export class DevLoginRequiredError extends Error {
    constructor(public readonly pageUrl: string) {
        super(`Dev store login required: ${pageUrl}`);
        this.name = 'DevLoginRequiredError';
    }
}

let _browser: Browser | undefined;

async function getBrowser(): Promise<Browser> {
    if (_browser) return _browser;
    const { chromium } = await import('playwright');
    _browser = await chromium.launch({ headless: getEnv().PLAYWRIGHT_HEADLESS });
    return _browser;
}

export async function renderPage(url: string, devPassword?: string): Promise<PageSignals> {
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
        networkErrors.push(
            `${req.method()} ${req.url()} — ${req.failure()?.errorText ?? 'failed'}`,
        );
    });

    let status = 0;
    let responseHeaders: Record<string, string> = {};
    try {
        const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 });
        const shopify = await page.evaluate<unknown>(`window.Shopify`);

        if (!shopify) {
            const isPasswordPage = await page.evaluate<boolean>(
                `!!(document.querySelector('input[type="password"]') || document.querySelector('form[action*="password"]'))`,
            );

            if (isPasswordPage) {
                console.log("devPassword: ", devPassword)
                if (!devPassword) {
                    await context.close();
                    throw new DevLoginRequiredError(url);
                }
                await page.locator('input[type="password"]').first().fill(devPassword);
                await page.locator('[type="submit"]').first().click();
                await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
            }
        }

        status = response?.status() ?? 0;
        responseHeaders = (response?.headers() ?? {}) as Record<string, string>;
    } catch (err) {
        if (err instanceof DevLoginRequiredError) throw err;
        status = 0;
    }

    const title = await page.title().catch(() => '');
    const html = await page.content().catch(() => '');
    const scripts = await page
        .evaluate<
            string[]
        >(`Array.from(document.querySelectorAll('script[src]')).map(function(s){return s.getAttribute('src')||''})`)
        .catch(() => [] as string[]);

    await context.close();

    return {
        title,
        status,
        html: html.slice(0, 50_000),
        scripts,
        consoleErrors,
        networkErrors,
        responseHeaders,
    };
}

export async function closeBrowser(): Promise<void> {
    if (_browser) {
        await _browser.close();
        _browser = undefined;
    }
}
