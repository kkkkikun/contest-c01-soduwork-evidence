#!/usr/bin/env node
'use strict';
/* ============================================================================
 * C01 · SoduWork「确定性门禁」真实实测探针
 *
 * 目的：不依赖任何模型 API Key，直接 require 上游的
 *       client/main/conversation/goal-verifier.js，用构造出来的交付物
 *       实跑它的门禁逻辑，把「运行结果」与「源码行」对上。
 *
 * ⚠️ 实验设计说明（这是本脚本第二版的核心改动）
 *   第一版把「坏引用」写成裸 `import './missing.js';`，而上游的模块引用正则是
 *   /(?:from\s*|import\s*\(\s*)(["'])(.*?)\1/gi —— **不匹配裸 import**。
 *   也就是说第一版根本没扫描到那个坏引用，漏检与体积/文件数上限无关，
 *   实验**没有判别力**。第二版因此做了三件事：
 *     ① 坏引用一律写成 `import x from './missing.js';`（能被正则匹配）；
 *     ② 增加**对照用例 6**：同样构造、但文件未超限 → 必须能被查出；
 *     ③ 增加**上限放宽变体（用例 7/8）**：把上游模块复制一份，
 *        把 MAX_TEXT_BYTES / MAX_SITE_FILES 改大后重跑同一构造 → 必须能被查出。
 *   ①+②+③ 合起来才构成闭环归因：**漏检确实由那两个上限引起**。
 *
 * 用法：
 *   node probe_goal_verifier.js [--repo /path/to/SoduWork]
 *
 * 环境变量：
 *   SODU_REPO   上游仓库路径（默认 ~/SoduWork）
 *
 * 退出码：0 = 全部用例与预期一致；非 0 = 有用例与预期不符（以实测值为准）。
 * 本脚本不内置任何"标准输出"——所有结论都是当次跑出来的。
 * ========================================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const repoArg = (() => {
  const i = args.indexOf('--repo');
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
})();
const REPO = path.resolve(
  repoArg || process.env.SODU_REPO || path.join(os.homedir(), 'SoduWork'));
const CONVERSATION = path.join(REPO, 'client', 'main', 'conversation');
const VERIFIER = path.join(CONVERSATION, 'goal-verifier.js');
/** 输出里只显示 ~ 形式的家目录路径，使结果与「谁在哪台机器上跑」无关，便于逐字复现 */
const disp = (p) => {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
};

if (!fs.existsSync(VERIFIER)) {
  console.error(`找不到被测模块：${VERIFIER}\n请用 --repo 或 SODU_REPO 指向 SoduWork 克隆目录。`);
  process.exit(2);
}
const { verify: verifyOriginal } = require(VERIFIER);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-gate-'));
const COMMIT = (() => {
  try {
    return execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (_) {
    return 'unknown';
  }
})();

/* ------------------------------------------------------- 放宽上限的模块副本 */
function buildRelaxedVerifier() {
  const dir = path.join(ROOT, 'relaxed');
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(CONVERSATION, dir, { recursive: true });
  const file = path.join(dir, 'goal-verifier.js');
  const src = fs.readFileSync(file, 'utf8')
    .replace('const MAX_TEXT_BYTES = 2 * 1024 * 1024;',
      'const MAX_TEXT_BYTES = 1024 * 1024 * 1024;')
    .replace('const MAX_SITE_FILES = 120;',
      'const MAX_SITE_FILES = 100000;');
  fs.writeFileSync(file, src);
  return require(file).verify;
}

/* ---------------------------------------------------------------- 构造工具 */
function makeWorkspace(name, files, manifest) {
  const cwd = path.join(ROOT, name);
  fs.mkdirSync(cwd, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  fs.mkdirSync(path.join(cwd, '.soduwork'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.soduwork', 'delivery.json'),
    JSON.stringify({ schemaVersion: 1, deliverables: manifest, summary: name }, null, 2),
  );
  return cwd;
}

/** 注意：verify 的实现可被替换，用于「放宽上限」变体实验 */
function runGate(verify, cwd, workKind) {
  return verify({
    cwd,
    profile: { kind: 'general', complete: true },
    spec: { workKind, workKinds: [workKind], complete: true },
    evidence: { mutation: true, verification: true },
    outputSnapshot: { files: [] },
  });
}

function checkOf(result, key) {
  return (result.checks || []).find((item) => item.key === key) || null;
}

/** 造一个指定大小、内容以 end 结尾的 JS 文件 */
function bigJs(bytes, end) {
  let s = '';
  const unit = '// ' + 'x'.repeat(120) + '\n';
  while (s.length < bytes) s += unit;
  return s + end;
}

/** 造一组资源文件，只有第 targetIndex 个里藏坏引用 */
function assetSet(count, targetIndex, badRef) {
  const files = {};
  for (let i = 1; i <= count; i += 1) {
    files[`asset-${i}.js`] = (i === targetIndex)
      ? `import x from '${badRef}';\n`
      : `export const n = ${i};\n`;
  }
  return files;
}

/* ------------------------------------------------------------------ 用例集 */
const CASES = [];
function addCase(def) { CASES.push(def); }

// 用例 1：文档任务却交网页 —— 期望 delivery_type 拦截
addCase({
  name: '文档任务却交网页',
  expect: 'delivery_type = FAIL',
  build: () => ({
    cwd: makeWorkspace('case-type-mismatch', {
      'result.html': '<!doctype html><html><head><title>t</title></head><body>ok</body></html>',
    }, [{ path: 'result.html', kind: 'website' }]),
    workKind: 'document',
  }),
  judge: (r) => {
    const c = checkOf(r, 'delivery_type');
    return { hit: c && c.pass === false, detail: c ? c.reason : '（无此检查项）' };
  },
});

// 用例 2：网站交付引用了不存在的本地资源 —— 期望 website_package_1 拦截
addCase({
  name: '网站引用缺失的本地资源',
  expect: 'website_package_1 = FAIL',
  build: () => ({
    cwd: makeWorkspace('case-missing-resource', {
      'index.html': '<!doctype html><html><head><script src="./missing.js"></script></head><body>x</body></html>',
    }, [{ path: 'index.html', kind: 'website' }]),
    workKind: 'website',
  }),
  judge: (r) => {
    const c = checkOf(r, 'website_package_1');
    return { hit: c && c.pass === false, detail: c ? c.reason : '（无此检查项）' };
  },
});

// 用例 3：超大文本文件（3 MB > MAX_TEXT_BYTES）里的坏引用 —— 原版应漏检
addCase({
  name: '超大文本文件(3MB)里的坏引用是否被查出【原版上限】',
  expect: 'website_package_1 = PASS（该文件超过 MAX_TEXT_BYTES=2MB 被跳过扫描，坏引用漏检）',
  build: () => ({
    cwd: makeWorkspace('case-oversize-text', {
      'index.html': '<!doctype html><html><head><script src="./big.js"></script></head><body>x</body></html>',
      'big.js': bigJs(3 * 1024 * 1024, "import x from './missing-inside-big.js';\n"),
    }, [{ path: 'index.html', kind: 'website' }]),
    workKind: 'website',
  }),
  judge: (r) => {
    const c = checkOf(r, 'website_package_1');
    return { hit: c && c.pass === true, detail: c ? c.reason || '（通过，无缺口）' : '（无此检查项）' };
  },
});

// 用例 4：站点资源数超过 MAX_SITE_FILES —— 原版应漏检
addCase({
  name: '站点资源数 130（超过 MAX_SITE_FILES=120）时第 130 个文件里的坏引用【原版上限】',
  expect: 'website_package_1 = PASS（遍历在 120 个文件处封顶，后续文件不被扫描，坏引用漏检）',
  build: () => ({
    cwd: makeWorkspace('case-many-files', Object.assign({
      'index.html': '<!doctype html><html><head>' +
        Array.from({ length: 130 }, (_, i) => `<script src="./asset-${i + 1}.js"></script>`).join('') +
        '</head><body>x</body></html>',
    }, assetSet(130, 130, './missing-beyond-cap.js')),
    [{ path: 'index.html', kind: 'website' }]),
    workKind: 'website',
  }),
  judge: (r) => {
    const c = checkOf(r, 'website_package_1');
    return { hit: c && c.pass === true, detail: c ? c.reason || '（通过，无缺口）' : '（无此检查项）' };
  },
});

// 用例 5：干净的网站交付 —— 期望全部通过（正对照）
addCase({
  name: '干净的网站交付（正对照）',
  expect: '全部检查项 PASS',
  build: () => ({
    cwd: makeWorkspace('case-clean', {
      'index.html': '<!doctype html><html><head><script src="./app.js"></script></head><body>ok</body></html>',
      'app.js': 'export const ok = true;\n',
    }, [{ path: 'index.html', kind: 'website' }]),
    workKind: 'website',
  }),
  judge: (r) => ({ hit: r.pass === true, detail: r.summary }),
});

// 用例 6（对照）：同样构造、但文件只有 1 MB（未超限）—— 必须能被查出
addCase({
  name: '同样构造但文件只有 1MB（未超限）【对照组】',
  expect: 'website_package_1 = FAIL（同一构造在未超限时能被查出 → 证明构造本身有效）',
  build: () => ({
    cwd: makeWorkspace('case-control-small', {
      'index.html': '<!doctype html><html><head><script src="./big.js"></script></head><body>x</body></html>',
      'big.js': bigJs(1024 * 1024, "import x from './missing-inside-big.js';\n"),
    }, [{ path: 'index.html', kind: 'website' }]),
    workKind: 'website',
  }),
  judge: (r) => {
    const c = checkOf(r, 'website_package_1');
    return { hit: c && c.pass === false, detail: c ? c.reason : '（无此检查项）' };
  },
});

// 用例 7（放宽上限变体）：同一构造 + 放宽 MAX_TEXT_BYTES —— 必须能被查出
addCase({
  name: '同样构造，把 MAX_TEXT_BYTES 放宽到 1GB 后重跑【上限放宽变体】',
  expect: 'website_package_1 = FAIL（放宽上限后同一构造被查出 → 归因闭环）',
  relaxed: true,
  build: () => ({
    cwd: makeWorkspace('case-relaxed-size', {
      'index.html': '<!doctype html><html><head><script src="./big.js"></script></head><body>x</body></html>',
      'big.js': bigJs(3 * 1024 * 1024, "import x from './missing-inside-big.js';\n"),
    }, [{ path: 'index.html', kind: 'website' }]),
    workKind: 'website',
  }),
  judge: (r) => {
    const c = checkOf(r, 'website_package_1');
    return { hit: c && c.pass === false, detail: c ? c.reason : '（无此检查项）' };
  },
});

// 用例 8（放宽上限变体）：同一构造 + 放宽 MAX_SITE_FILES —— 必须能被查出
addCase({
  name: '同样构造，把 MAX_SITE_FILES 放宽到 100000 后重跑【上限放宽变体】',
  expect: 'website_package_1 = FAIL（放宽上限后同一构造被查出 → 归因闭环）',
  relaxed: true,
  build: () => ({
    cwd: makeWorkspace('case-relaxed-files', Object.assign({
      'index.html': '<!doctype html><html><head>' +
        Array.from({ length: 130 }, (_, i) => `<script src="./asset-${i + 1}.js"></script>`).join('') +
        '</head><body>x</body></html>',
    }, assetSet(130, 130, './missing-beyond-cap.js')),
    [{ path: 'index.html', kind: 'website' }]),
    workKind: 'website',
  }),
  judge: (r) => {
    const c = checkOf(r, 'website_package_1');
    return { hit: c && c.pass === false, detail: c ? c.reason : '（无此检查项）' };
  },
});

/* -------------------------------------------------------------------- 主流程 */
console.log('='.repeat(78));
console.log('SoduWork 确定性门禁（goal-verifier.js）真实实测');
console.log(`被测模块 = ${disp(VERIFIER)}`);
console.log(`上游 commit = ${COMMIT}`);
console.log('='.repeat(78));

const verifyRelaxed = buildRelaxedVerifier();
let mismatches = 0;
for (const def of CASES) {
  const { cwd, workKind } = def.build();
  const impl = def.relaxed ? verifyRelaxed : verifyOriginal;
  const result = runGate(impl, cwd, workKind);
  const { hit, detail } = def.judge(result);
  if (!hit) mismatches += 1;
  console.log('');
  console.log(`[用例 ${CASES.indexOf(def) + 1}] ${def.name}`);
  console.log(`  期望：${def.expect}`);
  console.log(`  实际：${hit ? '与预期一致' : '与预期不一致 ⚠'}　overall.pass=${result.pass}　summary=${result.summary}`);
  console.log(`  详情：${detail}`);
  console.log('  逐项：');
  for (const c of result.checks) {
    const mark = c.pass ? 'PASS' : 'FAIL';
    console.log(`    [${mark}] ${c.key.padEnd(22)} ${c.label}` +
      (c.pass ? '' : `　→ ${c.reason}`));
  }
}

console.log('');
console.log('='.repeat(78));
if (mismatches) {
  console.log(`结论：${mismatches} 个用例与预期不符 —— 以实测值为准，不要改预期凑数。`);
  console.log('='.repeat(78));
  process.exit(1);
}
console.log(`结论：${CASES.length} 个用例全部与预期一致。`);
console.log('='.repeat(78));
try {
  fs.rmSync(ROOT, { recursive: true, force: true });
} catch (_) { /* 临时目录清理失败不影响结论 */ }
