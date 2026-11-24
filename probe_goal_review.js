#!/usr/bin/env node
'use strict';
/* ============================================================================
 * C01 · SoduWork「独立复核协议层」真实实测探针
 *
 * 目的：不依赖任何模型 API Key，直接 require 上游的
 *       client/main/conversation/goal-review.js 的 outcome()，
 *       实跑它的**判定与阻断分支**，把「运行结果」与「源码行」对上。
 *
 * ⚠️ 边界声明（很重要，勿夸大）
 *   本脚本测的是 **goal-review 的协议层**：它拿到一段「模型输出」之后，
 *   如何判定、能否放行、什么情况下强制阻断。
 *   **它不测模型本身**——模型返回的内容由本脚本用构造样本代替。
 *   所以它能证明的是「即使模型想放行，这段代码也不会让它放行」，
 *   **不能**证明「模型给出的评审结论质量如何」。
 *
 * 用法：
 *   node probe_goal_review.js [--repo /path/to/SoduWork]
 *
 * 退出码：0 = 全部用例与预期一致；非 0 = 有用例与预期不符（以实测值为准）。
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
const MODULE_PATH = path.join(REPO, 'client', 'main', 'conversation', 'goal-review.js');
/** 输出里只显示 ~ 形式的家目录路径，使结果与「谁在哪台机器上跑」无关，便于逐字复现 */
const disp = (p) => {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
};

if (!fs.existsSync(MODULE_PATH)) {
  console.error(`找不到被测模块：${MODULE_PATH}`);
  process.exit(2);
}
const { outcome } = require(MODULE_PATH);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-review-'));
const COMMIT = (() => {
  try {
    return execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (_) {
    return 'unknown';
  }
})();

/* --------------------------------------------------------- 协议层的固定输入 */
const SPEC = {
  dimensions: [
    { key: 'correctness', label: '正确性', threshold: 80, weight: 1, hard: true },
    { key: 'completeness', label: '完整性', threshold: 80, weight: 1, hard: true },
  ],
  qualityThreshold: 85,
};

const DETERMINISTIC_PASS = { pass: true, gaps: [], summary: '确定性验收已通过' };
const DETERMINISTIC_FAIL = {
  pass: false,
  gaps: [{ check: 'delivery_type', reason: '缺少 document/pdf，实际为 website', action: '换成文档再交' }],
  summary: '确定性交付验收未通过',
};

const REVIEW_OK = {
  verdict: 'pass',
  summary: '独立复核已通过',
  gaps: [],
  scores: { correctness: { score: 95 }, completeness: { score: 92 } },
};
const REVIEW_LOW = {
  verdict: 'pass',
  summary: '我认为可以过',
  gaps: [],
  scores: { correctness: { score: 60 }, completeness: { score: 58 } },
};
const REVIEW_MISSING_SCORES = {
  verdict: 'pass',
  summary: '我觉得没问题',
  gaps: [],
  scores: { correctness: { score: 95 } },
};

/* ------------------------------------------------------------------ 用例集 */
const CASES = [];
function addCase(def) { CASES.push(def); }

// R1：确定性门禁已失败，模型评审却说「通过」——必须被挡住
addCase({
  name: '确定性门禁已失败 + 独立复核 verdict=pass',
  expect: "phase=blocked 且 source=deterministic-verifier（模型不能覆盖已失败的确定性门禁）",
  deterministic: DETERMINISTIC_FAIL,
  value: JSON.stringify(REVIEW_OK),
  judge: (r) => ({
    hit: r.phase === 'blocked' && r.source === 'deterministic-verifier',
    detail: `phase=${r.phase} source=${r.source} reason=${r.reason}`,
  }),
});

// R2：畸形 JSON
addCase({
  name: '确定性门禁通过 + 独立复核返回畸形 JSON',
  expect: "phase=blocked 且 source=verifier-protocol（畸形输入不被兜底成通过）",
  deterministic: DETERMINISTIC_PASS,
  value: '{ this is not json',
  judge: (r) => ({
    hit: r.phase === 'blocked' && r.source === 'verifier-protocol',
    detail: `phase=${r.phase} source=${r.source} reason=${r.reason}`,
  }),
});

// R3：verdict=pass 但评分维度缺失
addCase({
  name: 'verdict=pass 但缺少一个评分维度',
  expect: 'phase=blocked 且 source=verifier-protocol（缺字段不能放行）',
  deterministic: DETERMINISTIC_PASS,
  value: JSON.stringify(REVIEW_MISSING_SCORES),
  judge: (r) => ({
    hit: r.phase === 'blocked' && r.source === 'verifier-protocol',
    detail: `phase=${r.phase} source=${r.source} reason=${r.reason}`,
  }),
});

// R4：verdict=pass 但综合分低于门槛 85
addCase({
  name: 'verdict=pass 但综合分只有 59 分（门槛 85）',
  expect: "phase=blocked 且 source=independent-verifier（模型说 pass 会被强制降级为 repair）",
  deterministic: DETERMINISTIC_PASS,
  value: JSON.stringify(REVIEW_LOW),
  judge: (r) => ({
    hit: r.phase === 'blocked' && r.source === 'independent-verifier',
    detail: `phase=${r.phase} source=${r.source} reason=${r.reason}`,
  }),
});

// R5：verdict 是无效值
addCase({
  name: 'verdict 返回无效值（looks good）',
  expect: 'phase=blocked 且 source=verifier-protocol（无效 verdict 不放行）',
  deterministic: DETERMINISTIC_PASS,
  value: JSON.stringify({ verdict: 'looks good', summary: '还行吧', gaps: [],
    scores: { correctness: { score: 95 }, completeness: { score: 92 } } }),
  judge: (r) => ({
    hit: r.phase === 'blocked' && r.source === 'verifier-protocol'
      && /无效 verdict/.test(String(r.reason)),
    detail: `phase=${r.phase} source=${r.source} reason=${r.reason}`,
  }),
});

// R6：正对照 —— 全部条件满足
addCase({
  name: '确定性通过 + 完整评分且达标 + verdict=pass（正对照）',
  expect: 'phase=reviewed（唯一能放行的路径）',
  deterministic: DETERMINISTIC_PASS,
  value: JSON.stringify(REVIEW_OK),
  judge: (r) => ({
    hit: r.phase === 'reviewed',
    detail: `phase=${r.phase} source=${r.source} reason=${r.reason} score=${r.score && r.score.total}`,
  }),
});

/* -------------------------------------------------------------------- 主流程 */
console.log('='.repeat(78));
console.log('SoduWork 独立复核协议层（goal-review.js · outcome）真实实测');
console.log(`被测模块 = ${disp(MODULE_PATH)}`);
console.log(`上游 commit = ${COMMIT}`);
console.log('边界：本脚本测协议层的判定与阻断逻辑，不测模型输出质量。');
console.log('='.repeat(78));

let mismatches = 0;
for (const def of CASES) {
  const result = outcome(def.value, { deterministic: def.deterministic, spec: SPEC });
  const { hit, detail } = def.judge(result);
  if (!hit) mismatches += 1;
  console.log('');
  console.log(`[用例 ${CASES.indexOf(def) + 1}] ${def.name}`);
  console.log(`  期望：${def.expect}`);
  console.log(`  实际：${hit ? '与预期一致' : '与预期不一致 ⚠'}`);
  console.log(`  详情：${detail}`);
  if (result.gaps && result.gaps.length) {
    console.log(`  缺口：${result.gaps.map((g) => `${g.check} → ${g.reason}`).join('；')}`);
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
