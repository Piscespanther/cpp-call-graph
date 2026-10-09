/**
 * 版本号替换（避免 PowerShell 的引号转义问题）。
 *
 * 同时更新 package.json 与 package-lock.json 顶层的两个 version 字段。
 * 立此步骤的原因：曾只改 package.json，锁文件长期停在 0.1.0，
 * 与 package.json 的 0.19.x 明显矛盾（`npm ci` 的可复现性描述会失真）。
 *
 * 只动「顶层」的 version/name，不碰 "packages" 里 322 个依赖的元数据，
 * 也不重新解析-回写整个锁文件（那会打乱 npm 的格式）。
 */
const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(String(target))) {
  console.error(`版本号格式不对：${target}（应为 x.y.z）`);
  process.exit(1);
}

const root = path.join(__dirname, '..');

// ---- 1) package.json ----
// 幂等：若已是目标版本就直接跳过（避免重复执行时误报失败）
const pkgFile = path.join(root, 'package.json');
const pkgText = fs.readFileSync(pkgFile, 'utf8');
const current = (pkgText.match(/"version": "(\d+\.\d+\.\d+)"/) || [])[1];
if (current !== target) {
  const pkgUpdated = pkgText.replace(/"version": "\d+\.\d+\.\d+"/, `"version": "${target}"`);
  if (pkgUpdated === pkgText) {
    console.error('package.json：没有找到需要替换的版本号');
    process.exit(1);
  }
  fs.writeFileSync(pkgFile, pkgUpdated, 'utf8');
}

// ---- 2) package-lock.json（顶层 + packages[""] 两处版本）----
const lockFile = path.join(root, 'package-lock.json');
let lockChanged = 0;
if (fs.existsSync(lockFile)) {
  let lockText = fs.readFileSync(lockFile, 'utf8');

  // (a) 顶层 "version"：它出现在 "packages" 之前，限定在前半段替换
  const cut = lockText.indexOf('"packages"');
  const head = cut >= 0 ? lockText.slice(0, cut) : lockText;
  const tail = cut >= 0 ? lockText.slice(cut) : '';
  const newHead = head.replace(/"version": "\d+\.\d+\.\d+"/, `"version": "${target}"`);
  if (newHead !== head) {
    lockChanged += 1;
  }
  lockText = newHead + tail;

  // (b) packages[""] 的 version：npm 用 `"": { ... "version": "x.y.z" ... }` 记录根包。
  //     锚定在 `"": {` 之后的第一个 version 字段（缩进 6 空格）。
  const entry = /("\s*:\s*\{\r?\n\s*"name":[^\n]*\r?\n\s*"version":\s*")(\d+\.\d+\.\d+)(")/;
  const replaced = lockText.replace(entry, `$1${target}$3`);
  if (replaced !== lockText) {
    lockChanged += 1;
    lockText = replaced;
  } else {
    console.error('package-lock.json：未能定位 packages[""] 的版本字段（格式可能已变）');
  }

  fs.writeFileSync(lockFile, lockText, 'utf8');

  // 校验：JSON 仍可解析，且两处版本都指向目标
  const parsedLock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const topOk = parsedLock.version === target;
  const rootEntry = parsedLock.packages ? parsedLock.packages[''] : undefined;
  const rootOk = !rootEntry || rootEntry.version === target;
  if (!topOk || !rootOk) {
    console.error(
      `package-lock.json 同步失败：顶层=${parsedLock.version}，` +
        `packages[""]=${rootEntry ? rootEntry.version : '(无)'}`
    );
    process.exit(1);
  }
}

const parsed = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
console.log(`version=${parsed.version}`);
console.log(`displayName=${parsed.displayName}`);
console.log(`commands=${parsed.contributes.commands.length}`);
console.log(
  `editor/context=${parsed.contributes.menus['editor/context'].map((item) => item.group).join(',')}`
);
console.log(`contributes=${Object.keys(parsed.contributes).join(',')}`);
console.log(`package-lock.json ${lockChanged ? '已同步' : '无需改动'}`);
