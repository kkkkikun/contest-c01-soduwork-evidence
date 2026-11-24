#!/usr/bin/env node
'use strict';
/* ============================================================================
 * C01 · SoduWork「确定性门禁」真实实测探针
 *
 * 目的：不依赖任何模型 API Key，直接 require 上游的
 *       client/main/conversation/goal-verifier.js，用构造出来的交付物
 *       实跑它的门禁逻辑，把「运行结果」与「源码行」对上。
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
const VERIFIER = path.join(REPO, 'client', 'main', 'conversation', 'goal-verifier.js');

if (!fs.existsSync(VERIFIER)) {
  console.error(`找不到被测模块：${VERIFIER}\n请用 --repo 或 SODU_REPO 指向 SoduWork 克隆目录。`);
  process.exit(2);
}
const { verify } = require(VERIFIER);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-gate-'));
const COMMIT = (() => {
  try {
    return execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (_) {
    return 'unknown';
  }
})();

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

function runGate(cwd, workKind) {
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

/* ------------------------------------------------------------------ 用例集 */
const CASES = [];
function addCase(def) { CASES.push(def); }

// 用例 1：文档任务却交网页 —— 期望 delivery_type 拦截
addCase({
  name: '文档任务却交网页',
  expect: 'delivery_type = FAIL',
  build: () => {
    const cwd = makeWorkspace('case-type-mismatch', {
      'result.html': '<!doctype html><html><head><title>t</title></head><body>ok</body></html>',
    }, [{ path: 'result.html', kind: 'website' }]);
    return { cwd, workKind: 'document' };
  },
  judge: (r) => {
    const c = checkOf(r, 'delivery_type');
    return { hit: c && c.pass === false, detail: c ? c.reason : '（无此检查项）' };
  },
});

// 用例 2：网站交付引用了不存在的本地资源 —— 期望 website_package_1 拦截
addCase({
  name: '网站引用缺失的本地资源',
  expect: 'website_package_1 = FAIL',
  build: () => {
    const cwd = makeWorkspace('case-missing-resource', {
      'index.html': '<!doctype html><html><head><script src="./missing.js"></script></head><body>x</body></html>',
    }, [{ path: 'index.html', kind: 'website' }]);
    return { cwd, workKind: 'website' };
  },
  judge: (r) => {
    const c = checkOf(r, 'website_package_1');
    return { hit: c && c.pass === false, detail: c ? c.reason : '（无此检查项）' };
  },
});

// 用例 3：超大文本文件（> 2 MB）里的坏引用 —— 期望"不被发现"
addCase({
  name: '超大文本文件(>2MB)里的坏引用是否被查出',
  expect: 'website_package_1 = PASS（该文件因超过 MAX_TEXT_BYTES 被跳过扫描，坏引用漏检）',
  build: () => {
    // 3 MB 的 JS：里面引用一个不存在的文件
    const filler = '// ' + 'x'.repeat(64) + '\n';
    let big = '';
    while (big.length < 3 * 1024 * 1024) big += filler;
    big += "import './missing-inside-big.js';\n";
    const cwd = makeWorkspace('case-oversize-text', {
      'index.html': '<!doctype html><html><head><script src="./big.js"></script></head><body>x</body></html>',
      'big.js': big,
    }, [{ path: 'index.html', kind: 'website' }]);
    return { cwd, workKind: 'website' };
  },
  judge: (r) => {
    const c = checkOf(r, 'website_package_1');
    return { hit: c && c.pass === true, detail: c ? c.reason || '（通过，无缺口）' : '（无此检查项）' };
  },
});

// 用例 4：站点文件数超过 120 —— 期望"超出部分不被扫描"
addCase({
  name: '站点文件数超过 120 时，超限部分的坏引用是否被查出',
  expect: 'website_package_1 = PASS（遍历在 120 个文件处封顶，后续文件不被扫描，坏引用漏检）',
  build: () => {
    const files = {
      'index.html': '<!doctype html><html><head>' +
        Array.from({ length: 130 }, (_, i) => `<script src="./asset-${i + 1}.js"></script>`).join('') +
        '</head><body>x</body></html>',
    };
    for (let i = 1; i <= 130; i += 1) {
      files[`asset-${i}.js`] = (i === 130)
        ? "import './missing-beyond-cap.js';\n"          // 第 130 个文件：坏引用
        : `export const n = ${i};\n`;
    }
    const cwd = makeWorkspace('case-many-files', files,
      [{ path: 'index.html', kind: 'website' }]);
    return { cwd, workKind: 'website' };
  },
  judge: (r) => {
    const c = checkOf(r, 'website_package_1');
    return { hit: c && c.pass === true, detail: c ? c.reason || '（通过，无缺口）' : '（无此检查项）' };
  },
});

// 用例 5：干净的网站交付 —— 期望全部通过（正对照）
addCase({
  name: '干净的网站交付（正对照）',
  expect: '全部检查项 PASS',
  build: () => {
    const cwd = makeWorkspace('case-clean', {
      'index.html': '<!doctype html><html><head><script src="./app.js"></script></head><body>ok</body></html>',
      'app.js': 'export const ok = true;\n',
    }, [{ path: 'index.html', kind: 'website' }]);
    return { cwd, workKind: 'website' };
  },
  judge: (r) => ({ hit: r.pass === true, detail: r.summary }),
});

/* -------------------------------------------------------------------- 主流程 */
console.log('='.repeat(78));
console.log('SoduWork 确定性门禁（goal-verifier.js）真实实测');
console.log(`被测模块 = ${VERIFIER}`);
console.log(`上游 commit = ${COMMIT}`);
console.log('='.repeat(78));

let mismatches = 0;
for (const def of CASES) {
  const { cwd, workKind } = def.build();
  const result = runGate(cwd, workKind);
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
