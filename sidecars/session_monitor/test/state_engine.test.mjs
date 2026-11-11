import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCompactHint,
  DEFAULT_SETTINGS,
  evaluateConversationHealth,
  matchActiveProcess,
  parseMilestoneMarkdown,
  parsePsOutput,
  parseTranscript,
} from '../state_engine.mjs';

test('parseMilestoneMarkdown extracts done, active [/], and pending [ ] items accurately', () => {
  const md = `# Task Pulse 开发进度清单

- [x] 阶段 1：插件底座
- [/] 阶段 2：状态机实现
- [ ] 阶段 3：前端面板
- [ ] 阶段 4：联调挂载
`;
  const res = parseMilestoneMarkdown(md, 'task.md', '/tmp/task.md');
  assert.ok(res);
  assert.equal(res.total, 4);
  assert.equal(res.done, 1);
  assert.equal(res.activeCount, 1);
  assert.equal(res.percent, 25);
  assert.equal(res.currentText, '阶段 2：状态机实现');
});

test('matchActiveProcess aggregates subtree CPU% across parent sh and child worker PIDs', () => {
  const psSample = `
  100     1   0.0 10:00 /sbin/launchd
  500   100   0.0 00:45 /bin/zsh -c npm test -- --watchAll=false
  501   500   2.5 00:44 node /repo/node_modules/.bin/jest
  502   501  84.3 00:43 node /repo/node_modules/jest-worker/build/workers/processChild.js
`;
  const rows = parsePsOutput(psSample);
  assert.equal(rows.length, 4);

  const matched = matchActiveProcess(rows, {
    commandLine: 'npm test -- --watchAll=false',
    workspacePaths: ['/repo'],
    ownPid: 9999,
  });
  assert.ok(matched);
  assert.equal(matched.pid, 500);
  assert.equal(matched.cpu, 86.8);
  assert.equal(matched.processCount, 3);
});

test('evaluateConversationHealth transitions THINKING -> THINKING_DEEP (>60s) -> STUCK_SUSPECTED (>180s)', () => {
  const baseStart = 1_700_000_000_000;
  const hookState = {
    phase: 'thinking',
    turnStartedAt: baseStart,
    invocationStartedAt: baseStart,
    invocationNum: 3,
    modelName: 'Gemini 4 Carbon (High)',
  };

  // 25s -> healthy THINKING
  const h1 = evaluateConversationHealth({
    now: baseStart + 25_000,
    hookState,
    settings: DEFAULT_SETTINGS,
  });
  assert.equal(h1.state, 'THINKING');
  assert.equal(h1.severity, 'healthy');
  assert.equal(h1.alertKey, null);

  // 75s -> caution THINKING_DEEP (no false hang alert!)
  const h2 = evaluateConversationHealth({
    now: baseStart + 75_000,
    hookState,
    settings: DEFAULT_SETTINGS,
  });
  assert.equal(h2.state, 'THINKING_DEEP');
  assert.equal(h2.severity, 'caution');
  assert.equal(h2.alertKey, null);

  // 195s -> warning STUCK_SUSPECTED + macOS alertKey
  const h3 = evaluateConversationHealth({
    now: baseStart + 195_000,
    hookState,
    settings: DEFAULT_SETTINGS,
  });
  assert.equal(h3.state, 'STUCK_SUSPECTED');
  assert.equal(h3.severity, 'warning');
  assert.ok(h3.alertKey);
});

test('evaluateConversationHealth distinguishes active CPU command (never stuck) vs 0% CPU hung vs waiting approval', () => {
  const t0 = Date.parse('2026-11-11T10:00:00Z');
  const lines = [
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      created_at: '2026-11-11T10:00:00Z',
      content: '<USER_REQUEST>Run full test suite</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-11T10:00:05Z',
      input_tokens: 12000,
      cache_read_tokens: 24000,
      output_tokens: 400,
      thinking: '**Executing Test Suite**\nRunning pytest now.',
      tool_calls: [
        {
          name: 'run_command',
          args: { CommandLine: '"pytest tests/slow_suite.py"', toolSummary: '"Run pytest slow suite"' },
        },
      ],
    }),
  ].join('\n');

  const tr = parseTranscript(lines, t0 + 6_000);
  assert.equal(tr.pendingTools.length, 1);
  assert.equal(tr.tokens.currentContext, 36000);

  // Case A: 20s elapsed, NO OS process spawned -> WAITING_USER (likely waiting on permission prompt!)
  const waitApproval = evaluateConversationHealth({
    now: t0 + 28_000,
    transcript: tr,
    proc: null,
    settings: DEFAULT_SETTINGS,
  });
  assert.equal(waitApproval.state, 'WAITING_USER');
  assert.equal(waitApproval.badge, '等待权限确认');

  // Case B: 300s (5 min!) elapsed, but OS process has 45.2% CPU -> stays healthy TOOL_ACTIVE!
  const activeCpu = evaluateConversationHealth({
    now: t0 + 306_000,
    transcript: tr,
    proc: { pid: 1234, cpu: 45.2, command: 'pytest tests/slow_suite.py' },
    settings: DEFAULT_SETTINGS,
  });
  assert.equal(activeCpu.state, 'TOOL_ACTIVE');
  assert.equal(activeCpu.severity, 'healthy');
  assert.equal(activeCpu.alertKey, null);

  // Case C: 110s elapsed, OS process exists with 0.0% CPU -> STUCK_SUSPECTED!
  const hungCmd = evaluateConversationHealth({
    now: t0 + 116_000,
    transcript: tr,
    proc: { pid: 1234, cpu: 0.0, command: 'pytest tests/slow_suite.py' },
    settings: DEFAULT_SETTINGS,
  });
  assert.equal(hungCmd.state, 'STUCK_SUSPECTED');
  assert.equal(hungCmd.badge, '命令疑似挂起');
  assert.ok(hungCmd.alertKey);
});

test('parseTranscript extracts subagent conversationId and evaluates SUBAGENT_RUNNING', () => {
  const lines = [
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      created_at: '2026-11-11T10:00:00Z',
      content: '<USER_REQUEST>Audit architecture</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-11T10:00:02Z',
      tool_calls: [
        {
          name: 'invoke_subagent',
          args: { TypeName: '"scout"', Role: '"Architecture Researcher"', Prompt: '"Scan modules"' },
        },
      ],
    }),
    JSON.stringify({
      step_index: 2,
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-11T10:00:04Z',
      content: 'Created At: 2026-11-11T18:00:03+08:00\nCompleted At: 2026-11-11T18:00:04+08:00\nCreated the following subagent:\n{\n  "conversationId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"\n}',
    }),
    JSON.stringify({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-11T10:00:05Z',
      content: 'Subagent launched, waiting for findings.',
      tool_calls: [],
    }),
  ].join('\n');

  const tr = parseTranscript(lines, Date.parse('2026-11-11T10:00:05Z'));
  assert.equal(tr.subagentRefs.length, 1);
  assert.equal(tr.subagentRefs[0].conversationId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(tr.subagentRefs[0].role, 'Architecture Researcher');

  const health = evaluateConversationHealth({
    now: Date.parse('2026-11-11T10:00:20Z'),
    hookState: {
      phase: 'stopped',
      turnStartedAt: Date.parse('2026-11-11T10:00:00Z'),
      stop: { terminationReason: 'NO_TOOL_CALL', fullyIdle: false, stoppedAt: Date.parse('2026-11-11T10:00:06Z') },
    },
    transcript: tr,
    subagents: [
      {
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        role: 'Architecture Researcher',
        state: 'TOOL_ACTIVE',
        severity: 'healthy',
        badge: '工具执行中',
        headline: '读取 index.mjs',
        elapsedSec: 14,
        startedAtMs: Date.parse('2026-11-11T10:00:06Z'),
        stepCount: 7,
        isRunning: true,
      },
    ],
  });
  assert.equal(health.state, 'SUBAGENT_RUNNING');
  assert.match(health.badge, /1 个子代理运行中/);
});

test('parseTranscript & evaluateConversationHealth handle stream interruption without false stuck tool', () => {
  const t0 = Date.parse('2026-11-11T10:59:00Z');
  const lines = [
    JSON.stringify({
      step_index: 140,
      type: 'USER_INPUT',
      created_at: '2026-11-11T10:59:00Z',
      content: '<USER_REQUEST>插件里文案都用中文</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 144,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-11T10:59:15Z',
      tool_calls: [
        {
          name: 'write_file',
          args: { Path: '"/repo/sidecars/session_monitor/index.html"', Content: '"<html></html>"' },
        },
      ],
    }),
    JSON.stringify({
      step_index: 145,
      type: 'ERROR_MESSAGE',
      created_at: '2026-11-11T10:59:19Z',
      error: 'The stream was interrupted. Please continue the task you were working on.',
    }),
  ].join('\n');

  const tr = parseTranscript(lines, t0 + 19_000);
  // write_file must NOT remain in pendingTools once Step #145 ERROR_MESSAGE follows!
  assert.equal(tr.pendingTools.length, 0);
  const plannerRound = tr.rounds.find((r) => r.kind === 'planner');
  assert.equal(plannerRound.tools[0].status, 'INTERRUPTED');
  assert.match(tr.latestErrorStep.error, /模型输出流意外中断/);

  // Even if Stop hook never ran on transport drop, >=12s after error transitions to ERROR_STOPPED ('流传输中断')
  const hookDuringStream = {
    phase: 'thinking',
    turnStartedAt: t0,
    invocationStartedAt: t0 + 10_000,
    invocationNum: 2,
  };

  const retrySoon = evaluateConversationHealth({
    now: t0 + 24_000, // 5s after error
    hookState: hookDuringStream,
    transcript: tr,
  });
  assert.equal(retrySoon.state, 'RETRYING');

  const haltedAfterDrop = evaluateConversationHealth({
    now: t0 + 40_000, // 21s after error with no new invocation
    hookState: hookDuringStream,
    transcript: tr,
  });
  assert.equal(haltedAfterDrop.state, 'ERROR_STOPPED');
  assert.equal(haltedAfterDrop.badge, '流传输中断');
  assert.ok(haltedAfterDrop.alertKey);
});

test('parseTranscript computes accurate per-round and task-level Token/s (tokenSpeed)', () => {
  const tStart = Date.parse('2026-11-11T11:10:00Z');
  const lines = [
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      created_at: '2026-11-11T11:10:00Z',
      content: '<USER_REQUEST>还要看到每个任务的 token生成速度</USER_REQUEST>',
    }),
    // Round 1: 600 output tokens in 10s (11:10:00Z -> 11:10:10Z) => 60.0 Token/s
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-11T11:10:00Z',
      input_tokens: 10000,
      output_tokens: 600,
      tool_calls: [{ name: 'read_file', args: { Path: '"/repo/main.mjs"' } }],
    }),
    JSON.stringify({
      step_index: 2,
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-11T11:10:10Z',
      content: 'Created At: 2026-11-11T19:10:10+08:00\nCompleted At: 2026-11-11T19:10:11+08:00\nok',
    }),
    // Round 2 (final reply, no tool calls): 1000 output tokens in 12.5s via hook PreInvocation -> Stop => 80.0 Token/s
    JSON.stringify({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-11T11:10:12Z',
      input_tokens: 12000,
      output_tokens: 1000,
      content: '已完成开发',
    }),
  ].join('\n');

  const hookState = {
    recentHookEvents: [
      { event: 'PreInvocation', ts: tStart + 12_000, invocationNum: 2 },
      { event: 'Stop', ts: tStart + 24_500, terminationReason: 'NO_TOOL_CALL' },
    ],
    stop: { stoppedAt: tStart + 24_500, terminationReason: 'NO_TOOL_CALL' },
  };

  const tr = parseTranscript(lines, tStart + 24_500, hookState);
  assert.equal(tr.rounds.length, 2);
  assert.equal(tr.rounds[0].tps, 60.0);
  assert.equal(tr.rounds[1].tps, 80.0);
  assert.equal(tr.tokenSpeed.latestTps, 80.0);
  assert.equal(tr.tokenSpeed.peakTps, 80.0);
  // Weighted avg: (600 + 1000) / (10s + 12.5s) = 1600 / 22.5 = 71.1 Token/s
  assert.equal(tr.tokenSpeed.avgTps, 71.1);
  assert.equal(tr.tokenSpeed.measuredRounds, 2);
});

test('buildCompactHint uses active context window tokens (currentContext) as the core indicator', () => {
  // 即使有 300 步，只要当前上下文占用仅 4.5万 t，就不需要压缩
  assert.equal(buildCompactHint({ stepCount: 300, currentContext: 45_000 }), null);

  // 刚完成压缩（累计 420 步，但上下文已回落至 2.2万 t）：不提示
  assert.equal(buildCompactHint({ stepCount: 420, currentContext: 22_000 }), null);

  // 上下文达到 16万～20万 t：触发 gentle 轻提示（“建议压缩”）
  const gentle = buildCompactHint({ stepCount: 60, currentContext: 175_000 });
  assert.ok(gentle);
  assert.equal(gentle.needed, true);
  assert.equal(gentle.level, 'gentle');
  assert.equal(gentle.label, '建议压缩');
  assert.match(gentle.message, /17\.5万 t/);

  // 上下文逼近 ~26万 自动压缩上限（>= 20万 t）：触发 strong 提示（“立即压缩”）
  const strong = buildCompactHint({ stepCount: 85, currentContext: 218_000 });
  assert.ok(strong);
  assert.equal(strong.level, 'strong');
  assert.equal(strong.label, '立即压缩');
  assert.match(strong.message, /21\.8万 t/);
});

test('parseTranscript drops currentContext after SYSTEM CHECKPOINT so compact hint clears naturally', () => {
  const lines = [
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      created_at: '2026-11-11T10:00:00Z',
      content: '<USER_REQUEST>\n/grill-me 实现会话监控面板\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 200,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-11T11:00:00Z',
      input_tokens: 8000,
      cache_read_tokens: 248000,
      output_tokens: 500,
    }),
    JSON.stringify({
      step_index: 201,
      source: 'SYSTEM',
      type: 'CHECKPOINT',
      created_at: '2026-11-11T11:01:00Z',
      input_tokens: 3000,
      cache_read_tokens: 256000,
      output_tokens: 1200,
      content: '# Resuming from a compaction',
    }),
    JSON.stringify({
      step_index: 202,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-11T11:01:15Z',
      input_tokens: 21500,
      cache_read_tokens: 0,
      output_tokens: 320,
      content: '继续执行任务',
    }),
  ].join('\n');

  const tr = parseTranscript(lines, Date.parse('2026-11-11T11:01:20Z'));
  assert.equal(tr.titleCandidate, '实现会话监控面板');
  assert.equal(tr.stepCount, 203);
  assert.equal(tr.compactCount, 1);
  assert.equal(tr.stepsSinceCompact, 1);
  assert.equal(tr.tokens.currentContext, 21500);
  assert.equal(
    buildCompactHint({
      stepCount: tr.stepCount,
      stepsSinceCompact: tr.stepsSinceCompact,
      compactCount: tr.compactCount,
      currentContext: tr.tokens.currentContext,
    }),
    null,
  );
});

test('parseTranscript & evaluateConversationHealth detect user message Revert (撤回) immediately without Stop hook', () => {
  const tPrevDone = Date.parse('2026-11-11T14:14:26Z');
  const tRevertTurn = Date.parse('2026-11-11T14:16:34Z');
  const tPlanner = Date.parse('2026-11-11T14:17:03Z');
  const tRevertedAt = Date.parse('2026-11-11T14:17:20Z');

  // Append-only transcript.jsonl retains reverted steps 952..958 even after user clicks 撤回
  const lines = [
    JSON.stringify({
      step_index: 950,
      type: 'USER_INPUT',
      created_at: '2026-11-11T14:13:00Z',
      content: '<USER_REQUEST>仓库里没啥代码啊</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 951,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-11T14:14:26Z',
      input_tokens: 21000,
      cache_read_tokens: 11000,
      output_tokens: 450,
      content: '代码都在 sidecars/session_monitor 目录下。',
      tool_calls: [],
    }),
    JSON.stringify({
      step_index: 952,
      type: 'USER_INPUT',
      created_at: '2026-11-11T14:16:34Z',
      content: '<USER_REQUEST>跟本地对比怎么少了那么多文件夹啊</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 958,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-11T14:17:03Z',
      input_tokens: 24000,
      cache_read_tokens: 12000,
      output_tokens: 300,
      tool_calls: [
        {
          name: 'run_command',
          args: { CommandLine: '"ls -la /Users/anon/dev/demo/agy-plugin/antigravity-session-monitor"' },
        },
      ],
    }),
  ].join('\n');

  // Stale hookState: PreInvocation fired at step 958, and Antigravity never fires Stop on Revert
  const staleHook = {
    phase: 'thinking',
    turnStartedAt: tRevertTurn,
    invocationStartedAt: tPlanner,
    invocationNum: 2,
    initialNumSteps: 957,
    stop: null,
  };

  // Host SQLite immediately deletes rows idx >= 952 -> liveStepCount drops to 952
  const runtimeMeta = {
    liveStepCount: 952,
    cascadeStatus: 'CASCADE_RUN_STATUS_IDLE',
    notFullyIdle: false,
    lastModifiedMs: tRevertedAt,
  };

  const tr = parseTranscript(lines, tPlanner, staleHook, runtimeMeta);
  assert.equal(tr.revertedTailSteps, 2);
  assert.equal(tr.pendingTools.length, 0);
  assert.equal(tr.stepCount, 952);
  assert.equal(tr.tokens.currentContext, 32000);
  assert.equal(tr.lastStepAtMs, tPrevDone);

  const health = evaluateConversationHealth({
    now: tRevertedAt + 35_000,
    hookState: staleHook,
    transcript: tr,
    runtimeMeta,
  });
  assert.equal(health.state, 'IDLE');
  assert.equal(health.badge, '已撤回');
  assert.equal(health.severity, 'idle');
  assert.equal(health.turnDurationSec, 0);
  assert.match(health.detail, /952 步/);

  // Edge case: Reverting the very first prompt of a brand-new conversation (liveStepCount -> 0)
  const trZero = parseTranscript(lines, tPlanner, staleHook, { ...runtimeMeta, liveStepCount: 0 });
  assert.equal(trZero.stepCount, 0);
  assert.equal(trZero.revertedTailSteps, 4);
  const healthZero = evaluateConversationHealth({
    now: tRevertedAt + 5_000,
    hookState: staleHook,
    transcript: trZero,
    runtimeMeta: { ...runtimeMeta, liveStepCount: 0 },
  });
  assert.equal(healthZero.state, 'IDLE');
  assert.equal(healthZero.badge, '已撤回');
});

test('parseTranscript folds historical step_index rollbacks when user reverts and sends a new message', () => {
  const lines = [
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      created_at: '2026-11-11T14:00:00Z',
      content: '<USER_REQUEST>初始化项目</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-11T14:00:05Z',
      input_tokens: 5000,
      output_tokens: 200,
      content: '已初始化',
    }),
    // Reverted branch (steps 2..3) left in append-only transcript.jsonl
    JSON.stringify({
      step_index: 2,
      type: 'USER_INPUT',
      created_at: '2026-11-11T14:01:00Z',
      content: '<USER_REQUEST>错误的提问分支</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-11T14:01:10Z',
      input_tokens: 99000,
      output_tokens: 8000,
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"rm -rf tmp"' } }],
    }),
    // User reverted step 2 and sent a new prompt -> step_index rewinds back to 2!
    JSON.stringify({
      step_index: 2,
      type: 'USER_INPUT',
      created_at: '2026-11-11T14:02:00Z',
      content: '<USER_REQUEST>正确的提问分支</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-11T14:02:08Z',
      input_tokens: 8000,
      output_tokens: 300,
      content: '已完成正确分支处理',
    }),
  ].join('\n');

  const tr = parseTranscript(lines, Date.parse('2026-11-11T14:02:08Z'), null, { liveStepCount: 4 });
  assert.equal(tr.rolledBackSteps, 2);
  assert.equal(tr.revertedTailSteps, 0);
  assert.equal(tr.stepCount, 4);
  assert.equal(tr.rounds.length, 2);
  // Ghost tokens (99000 in / 8000 out) from reverted branch must NOT be counted
  assert.equal(tr.tokens.input, 13000);
  assert.equal(tr.tokens.output, 500);
  assert.equal(tr.pendingTools.length, 0);
});

test('SQLite CORTEX_STEP_STATUS_WAITING (9), RUNNING (2), and CANCELED (6) drive exact zero-delay state transitions', () => {
  const t0 = Date.parse('2026-11-11T15:00:00Z');
  const lines = [
    JSON.stringify({
      step_index: 10,
      type: 'USER_INPUT',
      created_at: '2026-11-11T15:00:00Z',
      content: '<USER_REQUEST>部署测试环境</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 11,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-11T15:00:03Z',
      input_tokens: 10000,
      output_tokens: 250,
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"./deploy.sh"' } }],
    }),
  ].join('\n');

  const hook = {
    phase: 'thinking',
    turnStartedAt: t0,
    invocationStartedAt: t0 + 3_000,
    invocationNum: 1,
    initialNumSteps: 11,
  };

  // 1) Status 9 (WAITING): surfaces 等待权限确认 immediately at 1s without waiting 15s!
  const rtWaiting = {
    liveStepCount: 13,
    cascadeStatus: 'CASCADE_RUN_STATUS_RUNNING',
    notFullyIdle: true,
    hasWaitingStep: true,
    stepStatusByIndex: { 12: { status: 9, stepType: 132 } },
  };
  const trWait = parseTranscript(lines, t0 + 3_000, hook, rtWaiting);
  const hWait = evaluateConversationHealth({ now: t0 + 4_000, hookState: hook, transcript: trWait, runtimeMeta: rtWaiting });
  assert.equal(hWait.state, 'WAITING_USER');
  assert.equal(hWait.badge, '等待权限确认');

  // 2) Status 2 (RUNNING): approved low-CPU command at 25s stays TOOL_ACTIVE (never false 等待权限确认!)
  const rtRunning = {
    liveStepCount: 13,
    cascadeStatus: 'CASCADE_RUN_STATUS_RUNNING',
    notFullyIdle: true,
    hasRunningStep: true,
    stepStatusByIndex: { 12: { status: 2, stepType: 132 } },
  };
  const trRun = parseTranscript(lines, t0 + 3_000, hook, rtRunning);
  const hRun = evaluateConversationHealth({ now: t0 + 28_000, hookState: hook, transcript: trRun, proc: null, runtimeMeta: rtRunning });
  assert.equal(hRun.state, 'TOOL_ACTIVE');
  assert.equal(hRun.badge, '命令执行中');

  // 3) Status 6 (CANCELED) + CASCADE_RUN_STATUS_IDLE without Stop hook: transitions immediately to IDLE ('已手动停止')
  const rtCanceled = {
    liveStepCount: 13,
    cascadeStatus: 'CASCADE_RUN_STATUS_IDLE',
    notFullyIdle: false,
    hasCanceledTailStep: true,
    lastModifiedMs: t0 + 8_000,
    stepStatusByIndex: { 12: { status: 6, stepType: 132 } },
  };
  const trCancel = parseTranscript(lines, t0 + 3_000, hook, rtCanceled);
  assert.equal(trCancel.pendingTools.length, 0);
  const hCancel = evaluateConversationHealth({ now: t0 + 9_000, hookState: hook, transcript: trCancel, runtimeMeta: rtCanceled });
  assert.equal(hCancel.state, 'IDLE');
  assert.equal(hCancel.badge, '已手动停止');
});

