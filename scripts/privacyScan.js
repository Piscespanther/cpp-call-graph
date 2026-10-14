/**
 * 推送前的隐私审查：扫描「将要进入仓库 / 将要打进 VSIX」的文本内容，
 * 找出不该外发的本机信息。
 *
 * 为什么需要它：本工程的开发约定、暂存区笔记、Wiki 归档都在工作目录里，
 * 随手把路径、用户名、邮箱、令牌或本机目录名写进源码或注释，提交时就一起送出去了。
 * 人工眼看容易漏，所以做成一条可重复执行的检查。
 *
 * 覆盖范围：
 *   ① 仓库会跟踪的文件（`git ls-files --cached --others --exclude-standard`）
 *      —— 即 `git add -A` 之后真正会进提交的那些；
 *   ② `dist/` 产物（含 sourcemap）—— 它们会进 VSIX；
 *   ③ `--include <路径>` 指定的额外文件或目录（可重复）—— 用于审查**不在仓库里**、
 *      但可能要分发或给别人看的东西（测试夹具、暂存区脚本）。
 *      默认不扫它们：本脚本的默认口径是「会被推送出去的内容」。
 *
 * 分级：`block` 必须处理才能推送；`info` 需要人确认（例如「发布者 ID」是刻意公开的）。
 * 退出码：有 block 命中即 1；只有 info 命中为 0（但需人工确认）。
 *
 * ⚠️ 判据要防两类误报，否则满屏噪声等于没有检查：
 *   ① URL 的 `https://`、`file:///`、`vscode-webview://` 看起来像 `<字母>:/`，
 *      所以盘符前必须是**非字母数字**字符（用负向后顾）；
 *   ② `C:\Program Files\…`、`\Software\Microsoft\…`（注册表）这类**系统默认位置**是
 *      合法的兜底搜索目标，不是本机私有布局，放宽为不报。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

/** 只扫文本；二进制按扩展名跳过（字体、图片、压缩包等）。 */
const BINARY_EXT = new Set([
  '.ttf', '.otf', '.woff', '.woff2', '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.vsix', '.zip', '.gz', '.pdf', '.exe', '.dll', '.node',
]);

/** 系统默认位置 / 注册表根：出现在代码里属于正常兜底，不算本机私有布局。 */
const BENIGN_PREFIX = /^(?:Program Files(?: \(x86\))?|ProgramData|Windows|System32|LLVM|Microsoft VS Code)\b/i;
/**
 * UNC 的「第一段」若本身就是常见目录名（`\\resources\\app\\…`、`\\Software\\…`），
 * 那是被转义的普通路径或注册表根，不是内网主机名。
 */
const BENIGN_UNC = /^\\\\(?:Software|SOFTWARE|Microsoft|Classes|Wow6432Node|HKEY_|resources|bin|lib|share|src|dist|tools|scripts|extensions|app|node_modules|proj|work|temp|tmp|Users|home|LLVM|ProgramData|msys64|msys32|mingw64|mingw32)\b/i;
/** 去掉盘符与紧随其后的分隔符（源码里的 `C:\\Program Files` 会有两个反斜杠）。 */
const stripDrive = (value) => value.replace(/^[A-Za-z]:[\\/]+/, '');
/**
 * 正则源码的转义序列会被误当成路径（`d:\n`、`\\s*=\\s*`）。
 * 真路径里几乎不会出现 `\n`/`\s` 这类转义，直接排除这一类即可。
 */
const LOOKS_LIKE_REGEX_ESCAPE = /\\[nrtwsdbSWDB]|\*\?|\+\?/;

/**
 * 盘符路径：前面不能是字母数字（否则 `https://`、`size:` 会被当成盘符）；
 * 允许含空格，这样系统默认位置能被整段取出、交给白名单判断
 * （若在空格处截断，取到的只是盘符加第一段，白名单就认不出来了）。
 */
const DRIVE_PATH = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\n'"`)\]}>,;]*/g;

/**
 * 敏感字面量按片段拼出来，避免扫描器**把自己**扫成命中项 ——
 * 它必须和别的文件守同一条规矩，否则「审查工具自身」就成了唯一的漏网者。
 */
const FULLWIDTH_BANG = '\uFF01';
const LOCAL_NOTE_WORDS = [
  `${FULLWIDTH_BANG}${'临时'}`,
  `Pisces${'panther'}${'的'}Wiki`,
  `接续${'笔记'}`,
  `AGENTS-${'历史'}归档`,
];

const RULES = [
  {
    id: 'user-home-path',
    severity: 'block',
    re: /(?<![A-Za-z0-9_])[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\s'"`)\]}>,;]*/gi,
    why: '带用户名的家目录路径会直接把本机用户名公开出去。',
  },
  {
    id: 'posix-home',
    severity: 'block',
    re: /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+/g,
    why: '类 Unix 家目录同样暴露用户名。',
  },
  {
    id: 'workspace-path',
    severity: 'block',
    // 同步盘名同样按片段拼，免得本文件自己被 publisher-name 规则命中
    re: new RegExp(
      `(?<![A-Za-z0-9_])[A-Za-z]:[\\\\/][^\\s'"\`)\\]}>,;]*(?:remote_codehub|Desktop|tool_prj|cpp-call-graph-dev|Obsi${'dian'})[^\\s'"\`)\\]}>,;]*`,
      'gi'
    ),
    why: '本机工作目录/同步盘的名字会暴露开发环境布局。',
  },
  {
    id: 'local-notes',
    severity: 'block',
    re: new RegExp(LOCAL_NOTE_WORDS.join('|'), 'g'),
    why: '指向本机笔记库或暂存区笔记的引用不该随源码公开。',
  },
  {
    id: 'email',
    severity: 'block',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    why: '邮箱属于个人信息，公开仓库里出现即等于泄露。',
  },
  {
    id: 'token',
    severity: 'block',
    re: /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g,
    why: '凭据/私钥一旦进仓库必须立刻吊销，不能只靠删文件。',
  },
  {
    id: 'other-abs-path',
    severity: 'info',
    re: DRIVE_PATH,
    why: '非系统默认位置的绝对路径：多数是测试夹具（无隐私），但需要人确认一次。',
    allow: (value) =>
      BENIGN_PREFIX.test(stripDrive(value)) ||
      LOOKS_LIKE_REGEX_ESCAPE.test(value) ||
      LOOKS_LIKE_REGEX_ESCAPE.test(stripDrive(value)),
  },
  {
    id: 'unc-path',
    severity: 'info',
    // 第一段至少要 4 个字符：`\\s*`、`\\[` 这类正则转义会被排除
    re: /\\\\[A-Za-z0-9][A-Za-z0-9._-]{3,}\\[^\s'"`)\]}>,;]*/g,
    why: 'UNC/注册表路径：注册表根属正常，其它形式可能暴露内网主机名。',
    allow: (value) => BENIGN_UNC.test(value),
  },
  {
    id: 'ipv4',
    severity: 'info',
    re: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g,
    why: '固定 IP 可能指向内网或本机；也常出现在版本号里，需要人确认。',
    allow: (value) => value.startsWith('127.') || value === '0.0.0.0',
  },
  {
    id: 'publisher-name',
    severity: 'info',
    re: new RegExp(`\\b(?:Pisces${'panther'}|Obsi${'dian'}|One${'Drive'})\\b`, 'g'),
    why: '个人账号名/同步盘名。发布者 ID 是刻意公开的，命中后按上下文判断。',
  },
];

/**
 * 跳过的目录：版本库内部目录、依赖、工具缓存。
 *
 * `.cache` 单列是刻意的：clangd 之类的语言服务会把索引写进 `.cache/`，其中**含本机绝对路径**
 * （`--include` 一个 C 工程时实测 96/97 个 `.idx` 文件都带用户名）。它是工具缓存、不该进版本库
 * （夹具目录里已放 `.gitignore`），所以扫描时跳过；要确认缓存里有没有敏感内容，另跑
 * `cpp-call-graph-dev/scanToolCache.js` 一类的直接子串检查。
 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.vscode-test', '.cache']);

function runGit(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** fallback：git 不可用时退化成遍历。 */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      walk(path.join(dir, entry.name), out);
    } else {
      out.push(path.relative(ROOT, path.join(dir, entry.name)));
    }
  }
  return out;
}

/** 打码：只留头尾，避免把命中的敏感值原样再抄进日志或终端历史。 */
function mask(value) {
  if (value.length <= 10) {
    return value;
  }
  return `${value.slice(0, 8)}…${value.slice(-4)}（${value.length} 字符）`;
}

/**
 * 扫一个文件。
 *
 * @param absolute 绝对路径（可以是仓库之外的文件）
 * @param label 输出里显示的名字（仓库内给相对路径，仓库外给绝对路径）
 */
function scanFile(absolute, label, hits) {
  if (BINARY_EXT.has(path.extname(absolute).toLowerCase())) {
    return;
  }
  let text;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch {
    return;
  }
  if (text.includes('\u0000')) {
    return;
  }
  const lines = text.split('\n');
  for (const rule of RULES) {
    for (const [index, line] of lines.entries()) {
      rule.re.lastIndex = 0;
      let match = rule.re.exec(line);
      while (match) {
        const value = match[0];
        if (!rule.allow || !rule.allow(value)) {
          hits.push({ rule: rule.id, severity: rule.severity, why: rule.why, file: label, line: index + 1, value });
        }
        match = rule.re.exec(line);
      }
    }
  }
}

/** `--include <路径>`：列出仓库之外要一并审查的文件（文件或目录，可重复）。 */
function readIncludePaths() {
  const out = [];
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--include' && args[index + 1]) {
      out.push(path.resolve(process.cwd(), args[index + 1]));
      index += 1;
    }
  }
  return out;
}

/** 把一个绝对路径展开成待扫描的文件列表（目录则递归，跳过 .git / node_modules）。 */
function expand(absolute, out = []) {
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    console.error(`--include 路径不存在，已跳过：${absolute}`);
    return out;
  }
  if (stat.isFile()) {
    out.push(absolute);
    return out;
  }
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      expand(path.join(absolute, entry.name), out);
    } else if (entry.isFile()) {
      out.push(path.join(absolute, entry.name));
    }
  }
  return out;
}

/** 仓库内的文件显示相对路径，仓库外的显示绝对路径。 */
function labelOf(absolute) {
  const relative = path.relative(ROOT, absolute);
  return relative.startsWith('..') ? absolute : relative.split(path.sep).join('/');
}

function main() {
  const tracked = runGit(['ls-files', '--cached', '--others', '--exclude-standard']);
  const list = tracked ?? walk(ROOT);
  const extra = [];
  for (const candidate of ['dist/extension.js', 'dist/webview.js', 'dist/extension.js.map', 'dist/webview.js.map']) {
    if (fs.existsSync(path.join(ROOT, candidate))) {
      extra.push(candidate);
    }
  }

  const hits = [];
  const scanned = new Set();
  for (const relative of [...list, ...extra]) {
    if (scanned.has(relative)) {
      continue;
    }
    scanned.add(relative);
    scanFile(path.join(ROOT, relative), relative, hits);
  }

  const includePaths = readIncludePaths();
  const included = [];
  for (const includePath of includePaths) {
    for (const absolute of expand(includePath)) {
      if (included.includes(absolute)) {
        continue;
      }
      included.push(absolute);
      scanFile(absolute, labelOf(absolute), hits);
    }
  }

  console.log(
    `隐私审查：扫描 ${scanned.size} 个文件（仓库清单 ${list.length} + 产物 ${extra.length}）` +
      (included.length > 0 ? ` + --include ${included.length} 个` : '')
  );
  if (hits.length === 0) {
    console.log('未发现本机路径、用户名、邮箱、凭据等敏感内容 ✅');
    return 0;
  }

  // 按「规则 + 文件」聚合：同一处写法常常出现几十次，逐条打印等于没重点
  const groups = new Map();
  for (const hit of hits) {
    const key = `${hit.severity}|${hit.rule}|${hit.file}`;
    const group = groups.get(key) ?? { ...hit, count: 0, lines: [] };
    group.count += 1;
    if (group.lines.length < 3) {
      group.lines.push(hit.line);
    }
    groups.set(key, group);
  }

  const order = { block: 0, info: 1 };
  const sorted = [...groups.values()].sort(
    (a, b) => order[a.severity] - order[b.severity] || b.count - a.count
  );
  for (const group of sorted) {
    const more = group.count > group.lines.length ? ` 等 ${group.count} 处` : '';
    console.log(
      `[${group.severity}] ${group.rule} ${group.file}:${group.lines.join(',')}${more} → ${mask(group.value)}`
    );
    console.log(`        理由：${group.why}`);
  }
  const blocked = hits.filter((hit) => hit.severity === 'block').length;
  console.log(
    `共 ${hits.length} 处命中、归并为 ${sorted.length} 组（必须处理 ${blocked} 处，需人确认 ${hits.length - blocked} 处）`
  );
  return blocked > 0 ? 1 : 0;
}

process.exit(main());
