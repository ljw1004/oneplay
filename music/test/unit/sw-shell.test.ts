/**
 * Ensures the service-worker app shell stays in sync with the static module
 * graph rooted at src/index.ts. Any split/refactor that adds a module to the
 * startup import closure must add its dist/*.js artifact to APP_SHELL.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readAppShellEntries(swPath: string): Set<string> {
    const swSource = fs.readFileSync(swPath, 'utf8');
    const match = swSource.match(/const APP_SHELL = \[([\s\S]*?)\];/);
    assert.ok(match, 'APP_SHELL definition not found in sw.js');
    const entries = Array.from(match[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
    return new Set(entries);
}

function collectStaticImportClosureTs(entryTsPath: string, srcDir: string): Set<string> {
    const visited = new Set<string>();
    const requiredDistAssets = new Set<string>();
    const importPattern = /from\s+['"](\.\/[^'"]+\.js)['"]/g;

    const walk = (tsPath: string): void => {
        if (visited.has(tsPath)) return;
        visited.add(tsPath);
        requiredDistAssets.add(`./dist/${path.basename(tsPath).replace(/\.ts$/, '.js')}`);
        const source = fs.readFileSync(tsPath, 'utf8');
        for (const match of source.matchAll(importPattern)) {
            const depJs = match[1];
            const depTsPath = path.resolve(path.dirname(tsPath), depJs.replace(/\.js$/, '.ts'));
            if (!depTsPath.startsWith(srcDir + path.sep)) continue;
            if (!fs.existsSync(depTsPath)) continue;
            walk(depTsPath);
        }
    };

    walk(entryTsPath);
    return requiredDistAssets;
}

describe('service worker app shell coverage', () => {
    it('includes every dist module reachable from src/index.ts static imports', () => {
        const testDir = path.dirname(fileURLToPath(import.meta.url));
        const musicDir = path.resolve(testDir, '..', '..', '..');
        const srcDir = path.join(musicDir, 'src');
        const swPath = path.join(musicDir, 'sw.js');
        const entryTs = path.join(srcDir, 'index.ts');

        const appShellEntries = readAppShellEntries(swPath);
        const requiredDistAssets = collectStaticImportClosureTs(entryTs, srcDir);
        const missingAssets = Array.from(requiredDistAssets).filter((asset) => !appShellEntries.has(asset));

        assert.deepEqual(
            missingAssets,
            [],
            `APP_SHELL missing dist assets: ${missingAssets.join(', ')}`,
        );
    });
});
