/** Headless driver for the existing Diagram component and its Full diagram export. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

async function main(): Promise<void> {
    const { values } = parseArgs({ options: {
        input: { type: 'string', short: 'i' }, output: { type: 'string', short: 'o' },
        browser: { type: 'string' }, playwright: { type: 'string' },
        'separate-edges': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) {
        console.log('Usage: tsx src/cli/exportPng.ts --input schema.ts --output diagram.png [--browser chromium] [--playwright /path/to/playwright]\nUses the app Diagram.tsx and its existing Full diagram PNG export. Input is a trusted executable TS/JS schema module.');
        return;
    }
    if (!values.input || !values.output) throw new Error('Both --input and --output are required.');
    const input = resolve(values.input), output = resolve(values.output);
    if (!/\.(?:[cm]?[jt]s)$/.test(input)) throw new Error('Input must be a trusted TS/JS module.');
    if (!output.endsWith('.png')) throw new Error('The app export produces PNG; use a .png output.');
    const imported = await import(pathToFileURL(input).href);
    const payload = imported.payload ?? imported.default?.default ?? imported.default;
    if (!payload || !Array.isArray(payload.tables) || !payload.tables.length) throw new Error('Input must export a nonempty DiagramPayload.');
    const app = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const requireApp = createRequire(resolve(app, 'package.json'));
    const { chromium } = requireApp(values.playwright ?? 'playwright');
    const temporary = await mkdtemp(resolve(tmpdir(), 'db-diagram-export-'));
    let server: Awaited<ReturnType<typeof createServer>> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
        await writeFile(resolve(temporary, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="controls" style="position:absolute;left:0;top:0;width:230px"></div><div id="root" style="margin-left:230px;display:flex;flex-direction:column"></div><script type="module" src="/entry.tsx"></script></body></html>');
        // This entry only supplies schema data and the controls portal. All node,
        // edge, theme, layout and export rendering belongs to the existing app.
        await writeFile(resolve(temporary, 'entry.tsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import ${JSON.stringify('/@fs/' + resolve(app, 'src/renderer/styles.css'))};
import Diagram from ${JSON.stringify('/@fs/' + resolve(app, 'src/renderer/components/Diagram.tsx'))};
import * as input from ${JSON.stringify('/@fs/' + input)};
const payload = input.payload ?? input.default;
createRoot(document.getElementById('root')!).render(<Diagram payload={payload} controlsTarget={document.getElementById('controls') as HTMLDivElement} showMinimap={false} />);
`);
        server = await createServer({
            configFile: false, root: temporary, cacheDir: resolve(temporary, 'cache'),
            plugins: [react()],
            resolve: { alias: {
                '@shared': resolve(app, 'src/shared'),
                'react': resolve(app, 'node_modules/react'),
                'react-dom': resolve(app, 'node_modules/react-dom'),
                '@xyflow/react': resolve(app, 'node_modules/@xyflow/react'),
            } },
            server: { host: '127.0.0.1', port: 0, fs: { allow: [temporary, app, dirname(input)] } },
        });
        await server.listen();
        browser = await chromium.launch({ headless: true, ...(values.browser ? { executablePath: values.browser } : {}) });
        const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
        const errors: string[] = [];
        page.on('pageerror', (error: Error) => errors.push(error.message));
        await page.goto(server.resolvedUrls!.local[0]);
        await page.locator('.react-flow__node').nth(payload.tables.length - 1).waitFor();
        await page.waitForFunction(() => Array.from(document.querySelectorAll('.react-flow__node')).every(n => n.getBoundingClientRect().height > 40));
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
        const fkCount = payload.tables.reduce((n: number, t: { foreignKeys: unknown[] }) => n + t.foreignKeys.length, 0);
        if (await page.locator('.react-flow__edge').count() !== fkCount) throw new Error('Not all foreign keys rendered.');
        const appStyle = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pk').trim());
        if (appStyle !== '#f59e0b') throw new Error('Original app stylesheet was not applied.');
        if (values['separate-edges']) {
            // Move coincident trunks with the app's own edge drag handles.
            // No paths are drawn or replaced by the driver.
            const trunks = await page.evaluate(() => Array.from(document.querySelectorAll('.react-flow__edge')).flatMap(edge => {
                const d = edge.querySelector('.react-flow__edge-path')?.getAttribute('d') ?? '';
                const points = Array.from(d.matchAll(/[ML]\s*([-\d.e+]+)[,\s]+([-\d.e+]+)/g), m => [Number(m[1]), Number(m[2])]);
                const vertical = points.slice(1).map((point, i) => ({ x: point[0], y1: points[i][1], y2: point[1], length: Math.abs(point[1] - points[i][1]), dx: Math.abs(point[0] - points[i][0]) })).filter(s => s.dx < 0.5 && s.length > 10).sort((a, b) => b.length - a.length)[0];
                return vertical ? [{ id: edge.getAttribute('data-id')!, ...vertical }] : [];
            }));
            const groups = trunks.filter((t: { x: number }) => trunks.filter((other: { x: number }) => Math.abs(t.x - other.x) < 1).length > 1);
            let moved = 0;
            for (let index = 0; index < groups.length; index++) {
                const edge = page.locator(`.react-flow__edge[data-id="${groups[index].id}"]`);
                await edge.locator('.react-flow__edge-interaction').dispatchEvent('click');
                await edge.locator('g').first().dispatchEvent('mouseover');
                const handle = edge.locator('circle');
                await handle.waitFor({ state: 'visible', timeout: 5000 });
                const box = await handle.boundingBox();
                if (!box) throw new Error('App edge handle is unavailable.');
                const x = box.x + box.width / 2, y = box.y + box.height / 2;
                const offset = (index - (groups.length - 1) / 2) * 32;
                if (Math.abs(offset) < 1) continue;
                await page.mouse.move(x, y);
                await page.mouse.down();
                if (!await handle.evaluate((element: SVGCircleElement) => element.hasPointerCapture(1))) throw new Error(`App handle did not capture the pointer for ${groups[index].id}.`);
                await handle.dispatchEvent('pointermove', { pointerId: 1, clientX: x + offset, clientY: y, buttons: 1, pointerType: 'mouse', isPrimary: true });
                await page.mouse.up();
                moved++;
            }
            await page.mouse.move(5, 5);
            for (const group of groups) await page.locator(`.react-flow__edge[data-id="${group.id}"] g`).first().dispatchEvent('mouseout');
            await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 }, force: true });
            await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
            console.log(`Adjusted ${moved} overlapping trunks through the app's edge drag controls.`);
        }
        const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Full diagram', exact: true }).click()]);
        await download.saveAs(output);
        if (errors.length) throw new Error(errors.join('\n'));
        console.log(`Exported ${payload.tables.length} tables / ${fkCount} relationships via Diagram.tsx Full diagram: ${output}`);
    } finally {
        await browser?.close();
        await server?.close();
        await rm(temporary, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
