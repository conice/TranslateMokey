import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';

const candidates = [
  ['desktop-chrome', ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']],
  ['desktop-edge', ['microsoft-edge', 'microsoft-edge-stable']],
  ['desktop-firefox', ['firefox']],
  ['android-firefox', ['firefox']],
  ['playwright', ['playwright']],
];
const results = [];
for (const [name, binaries] of candidates) {
  const paths = [];
  for (const binary of binaries) {
    for (const directory of (process.env.PATH || '').split(':')) {
      if (!directory) continue;
      const path = `${directory}/${binary}`;
      try { await access(path, constants.X_OK); paths.push(binary); break; } catch { continue; }
    }
  }
  results.push({ name, found: paths, status: paths.length ? 'available-unverified' : 'unavailable' });
}
const content = JSON.stringify({ generatedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`,
  note: '存在可执行文件不代表已安装脚本、通过兼容测试或完成用户验收。', results }, null, 2);
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/browser-matrix.json', import.meta.url), `${content}\n`);
console.log(content);
