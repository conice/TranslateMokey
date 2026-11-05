import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const modules = ['core', 'review', 'dictionary', 'speech', 'storage', 'service', 'queue', 'annotations', 'reader', 'ui', 'main'];
const metadata = await readFile(new URL('src/metadata.txt', root), 'utf8');
const sources = await Promise.all(modules.map(async (name) => {
  const source = await readFile(new URL(`src/${name}.js`, root), 'utf8');
  return source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
}));
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/TranslateMokey.user.js', root), `${metadata}\n(() => {\n'use strict';\n${sources.join('\n')}\n})();\n`);
console.log('已构建 dist/TranslateMokey.user.js');
