import assert from 'node:assert/strict';
import fs from 'node:fs';
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url)));
assert.equal(manifest.js, 'index.js');
assert.equal(manifest.generate_interceptor, 'dicerollGenerateInterceptor');
assert.match(manifest.homePage, /^https:\/\/github\.com\/permissionBRICK\//);
for (const file of [manifest.js, manifest.css, 'README.md', 'LICENSE']) assert.ok(fs.existsSync(new URL(`../${file}`, import.meta.url)), file);
