'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const output = path.resolve(process.env.CONTEXTDECK_DISTRIBUTION_DIR || path.join(ROOT, packageJson.build.directories.output));
const appDir = path.join(output, 'win-unpacked');
const appAsar = path.join(appDir, 'resources', 'app.asar');
for (const file of [path.join(appDir, 'ContextDeck.exe'), appAsar]) {
  if (!fs.existsSync(file)) throw new Error(`missing distribution artifact: ${path.relative(ROOT, file)}`);
}
const stat = fs.statSync(appAsar);
if (!stat.isFile() || stat.size < 100 * 1024) throw new Error('app.asar is missing or unexpectedly small');
for (const name of ['archive.zip', 'config.json', 'chat-bindings.json', 'project-bindings.json', 'ui-state.json']) {
  if (fs.existsSync(path.join(output, name))) throw new Error(`forbidden local data in distribution output: ${name}`);
}
console.log(JSON.stringify({ productName: packageJson.build.productName, version: packageJson.version, appDir, appAsar, appAsarBytes: stat.size }, null, 2));
