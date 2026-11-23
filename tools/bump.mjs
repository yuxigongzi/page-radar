#!/usr/bin/env node
// 改版本号：一次改完三处，避免只改了一半。
//   node tools/bump.mjs 1.5.4           # 改文件
//   node tools/bump.mjs 1.5.4 --check   # 只看会改什么，不落盘
//   node tools/bump.mjs 1.5.4 --pack    # 改完顺手打包
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const version = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));
const check = args.includes('--check');
const pack = args.includes('--pack');

if (!version) {
  console.error('用法: node tools/bump.mjs <x.y.z> [--check] [--pack]');
  process.exit(1);
}

const manifestPath = join(ROOT, 'manifest.json');
const optionsPath = join(ROOT, 'options', 'options.html');
const readmePath = join(ROOT, 'README.md');

const manifestText = readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(manifestText);
const old = manifest.version;
if (old === version) {
  console.log(`版本已经是 ${version}，没有要改的。`);
  process.exit(0);
}

const edits = [];

// manifest.json：保留原有缩进风格（2 空格）
const nextManifest = JSON.stringify({ ...manifest, version }, null, 2) + (manifestText.endsWith('\n') ? '\n' : '');
edits.push([manifestPath, manifestText, nextManifest]);

// options 页脚
const optionsText = readFileSync(optionsPath, 'utf8');
const nextOptions = optionsText.replace(/页面更新雷达 v\d+\.\d+\.\d+/g, `页面更新雷达 v${version}`);
edits.push([optionsPath, optionsText, nextOptions]);

// README 里引用的 crx 文件名
const readmeText = readFileSync(readmePath, 'utf8');
const nextReadme = readmeText.replace(/page-radar-\d+\.\d+\.\d+\.crx/g, `page-radar-${version}.crx`);
edits.push([readmePath, readmeText, nextReadme]);

for (const [file, before, after] of edits) {
  const changed = before !== after;
  console.log(`${changed ? '改' : '跳过'} ${file.slice(ROOT.length + 1)}`);
  if (!check && changed) writeFileSync(file, after, 'utf8');
}

if (check) {
  console.log(`\n--check 模式：没有写文件。将把 ${old} → ${version}`);
  process.exit(0);
}

console.log(`\n版本号 ${old} → ${version}`);
if (pack) {
  console.log('\n开始打包…');
  try {
    execFileSync('python', ['tools/pack.py'], { cwd: ROOT, stdio: 'inherit' });
  } catch {
    execFileSync('python3', ['tools/pack.py'], { cwd: ROOT, stdio: 'inherit' });
  }
}
