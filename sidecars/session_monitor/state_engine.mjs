/**
 * Antigravity 会话监控核心状态机、对话轨迹与阶段清单解析器、子进程活跃度匹配引擎。
 * 保持纯函数无副作用设计，便于通过 `node --test` 独立完成确定性单元测试。
 */
import { basename } from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  notificationsEnabled: true,
  thinkingWarnSec: 60,
  thinkingStuckSec: 180,
  commandQuietStuckSec: 90,
  approvalHintSec: 15,
  completionNotifyMinSec: 60,
  compactHintSteps: 150,
  compactHintContextTokens: 160000,
});

export function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const clamp = (val, def, min, max) => {
    const n = Number(val);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
  };
  return {
    notificationsEnabled: typeof s.notificationsEnabled === 'boolean'
      ? s.notificationsEnabled
      : DEFAULT_SETTINGS.notificationsEnabled,
    thinkingWarnSec: clamp(s.thinkingWarnSec, DEFAULT_SETTINGS.thinkingWarnSec, 15, 600),
    thinkingStuckSec: clamp(s.thinkingStuckSec, DEFAULT_SETTINGS.thinkingStuckSec, 30, 1800),
    commandQuietStuckSec: clamp(s.commandQuietStuckSec, DEFAULT_SETTINGS.commandQuietStuckSec, 20, 1800),
    approvalHintSec: clamp(s.approvalHintSec, DEFAULT_SETTINGS.approvalHintSec, 5, 300),
    completionNotifyMinSec: clamp(s.completionNotifyMinSec, DEFAULT_SETTINGS.completionNotifyMinSec, 10, 3600),
    compactHintSteps: clamp(s.compactHintSteps, DEFAULT_SETTINGS.compactHintSteps, 80, 2000),
    compactHintContextTokens: clamp(
      s.compactHintContextTokens,
      DEFAULT_SETTINGS.compactHintContextTokens,
      50000,
      800000,
    ),
  };
}

function fmtContextBrief(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万 t`;
  return `${v.toLocaleString()} t`;
}

/**
 * 基于「当前上下文窗口 Token 占用量（`currentContext` = `input_tokens + cache_read_tokens`）」
 * 评估是否需要提示手动点击压缩（绝不后台自动代执行）。
 * 实测 Antigravity 在上下文达到约 25.8万～26.4万 t 时会触发强制自动压缩；压缩完成后 `currentContext`
 * 会立即回落至约 2.1万 t，提示随之自然消退。
 */
export function buildCompactHint(metricsOrContext, rawSettings = DEFAULT_SETTINGS) {
  const settings = normalizeSettings(rawSettings);
  const isObj = metricsOrContext && typeof metricsOrContext === 'object';
  const ctxTokens = isObj
    ? (Number(metricsOrContext.currentContext) || 0)
    : (Number(metricsOrContext) || 0);

  const softCtx = settings.compactHintContextTokens;
  const strongCtx = Math.max(softCtx + 40000, 200000);

  if (ctxTokens < softCtx) return null;

  const level = ctxTokens >= strongCtx ? 'strong' : 'gentle';
  return {
    needed: true,
    level,
    currentContext: ctxTokens,
    command: '/compact',
    label: level === 'strong' ? '立即压缩' : '建议压缩',
    message: level === 'strong'
      ? `当前上下文已达 ${fmtContextBrief(ctxTokens)}（接近 ~26万 自动压缩上限），点击直接压缩`
      : `当前上下文已达 ${fmtContextBrief(ctxTokens)}，可在合适时机点击直接压缩提速`,
  };
}

export function unquote(v) {
  if (typeof v !== 'string') return v == null ? '' : String(v);
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

export function oneLine(s, maxLen = 110) {
  const out = String(s || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > maxLen ? `${out.slice(0, maxLen - 1).trimEnd()}…` : out;
}

const TOOL_NAME_ZH = Object.freeze({
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  run_command: '执行终端命令',
  invoke_subagent: '派发子代理',
  define_subagent: '定义子代理',
  manage_subagents: '管理子代理',
  manage_task: '管理后台任务',
  send_message: '发送代理消息',
  ask_question: '向你提问确认',
  search_web: '检索网页资料',
  code_search: '检索代码库',
  search_marketplace: '检索插件市场',
  list_plugin_accounts: '查询插件账号',
  call_mcp_tool: '调用扩展服务工具',
  list_resources: '查询扩展资源列表',
  read_resource: '读取扩展资源',
  schedule: '配置定时任务',
  swarm: '调度协作群组',
  swarm_wait: '等待群组消息',
  read_board: '读取协作看板',
  post_message: '发布看板消息',
});

const SUBAGENT_TYPE_ZH = Object.freeze({
  scout: '代码检索子代理',
  developer: '编码开发子代理',
  reviewer: '架构审查子代理',
  browser: '浏览器操作子代理',
  research: '调研分析子代理',
  self: '通用子代理',
  'image-generator': '图像生成子代理',
  swarm: '群组协作节点',
});

const TERMINATION_REASON_ZH = Object.freeze({
  NO_TOOL_CALL: '正常完成',
  MAX_INVOCATIONS: '达到最大调用轮数上限',
  MAX_FORCED_INVOCATIONS: '达到强制续跑次数上限',
  MAX_TOKEN_BUDGET_EXCEEDED: '超出上下文词元预算上限',
  ERROR: '运行异常错误',
  USER_CANCELED: '用户手动取消',
  TERMINAL_STEP_TYPE: '到达终止步骤',
  TERMINAL_CUSTOM_HOOK: '由自定义钩子终止',
  INJECTED_RESPONSE: '注入回复后结束',
});

export function localizeModelName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/\(High\)/gi, '（高推理）')
    .replace(/\(Medium\)/gi, '（中推理）')
    .replace(/\(Low\)/gi, '（低推理）')
    .replace(/\(Max\)/gi, '（极高推理）')
    .replace(/^auto$/i, '自动选择模型');
}

export function localizeErrorText(raw) {
  const s = oneLine(raw || '', 220);
  if (!s) return '发生未知运行异常';
  if (/stream was interrupted/i.test(s)) {
    return '模型输出流意外中断，请点击「发消息追问/唤醒」继续执行刚才的任务';
  }
  if (/connection reset by peer/i.test(s)) {
    return '网络连接被远端重置，系统正在自动重连重试';
  }
  if (/RESOURCE_EXHAUSTED|exhausted your capacity/i.test(s)) {
    return '当前模型配额已耗尽或容量繁忙，请稍后或切换模型';
  }
  if (/\b429\b|rate.?limit/i.test(s)) {
    return '触发接口速率限制，系统正在退避重试';
  }
  if (/deadline exceeded|timed? out/i.test(s)) {
    return '模型接口请求超时';
  }
  return s;
}

export function extractUserPrompt(content) {
  if (typeof content !== 'string') return '';
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content);
  const raw = (m ? m[1] : content).trim().replace(/^\/[a-zA-Z0-9_-]+\s+/, '');
  return oneLine(raw, 100);
}

export function thinkingHeading(thinking) {
  if (typeof thinking !== 'string' || !thinking.trim()) return '';
  const hs = [...thinking.matchAll(/(?:^|\n)\s*(?:\*\*|#{1,3}\s+)([^*\n#]{3,96}?)(?:\*\*)?\s*(?=\n|$)/g)];
  if (hs.length) return oneLine(hs[hs.length - 1][1], 96);
  const lines = thinking
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 6);
  return lines.length ? oneLine(lines[lines.length - 1], 96) : '';
}

export function parseIsoMs(s) {
  if (!s || typeof s !== 'string') return null;
  const ms = Date.parse(s.trim());
  return Number.isFinite(ms) ? ms : null;
}

export function parseGenericTimestamps(content) {
  if (typeof content !== 'string') return { startedAtMs: null, completedAtMs: null };
  const cMatch = /^Created At:\s*([^\r\n]+)/m.exec(content);
  const dMatch = /^Completed At:\s*([^\r\n]+)/m.exec(content);
  return {
    startedAtMs: cMatch ? parseIsoMs(cMatch[1]) : null,
    completedAtMs: dMatch ? parseIsoMs(dMatch[1]) : null,
  };
}

export function describeToolCall(tc) {
  const name = String(tc?.name || '');
  if (!name) return { name: '', label: '', detail: '', commandLine: '', requestFeedback: false };
  const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
  const summary = unquote(args.toolSummary || args.toolAction || '');
  const path = unquote(args.Path || args.AbsolutePath || args.TargetFile || '');
  const cmd = unquote(args.CommandLine || '');
  const role = unquote(args.Role || '');
  const typeName = unquote(args.TypeName || '');
  const query = unquote(args.query || args.Query || '');
  const zhTool = TOOL_NAME_ZH[name] || '调用工具';

  let metaObj = args.ArtifactMetadata;
  if (typeof metaObj === 'string') {
    try {
      metaObj = JSON.parse(metaObj);
    } catch {
      metaObj = null;
    }
  }
  const requestFeedback = Boolean(
    metaObj && typeof metaObj === 'object' && (metaObj.RequestFeedback === true || metaObj.RequestFeedback === 'true'),
  );

  if (name === 'run_command') {
    const hasZhSummary = summary && /[\u4e00-\u9fff]/.test(summary);
    return {
      name,
      label: hasZhSummary ? oneLine(summary, 68) : (cmd ? `执行命令：${oneLine(cmd, 60)}` : '执行终端命令'),
      detail: cmd ? oneLine(cmd, 120) : '',
      commandLine: cmd,
      requestFeedback: false,
    };
  }
  if (name === 'invoke_subagent') {
    const zhType = SUBAGENT_TYPE_ZH[typeName] || '子代理';
    const subTitle = role || zhType;
    return {
      name,
      label: `派发子代理：${oneLine(subTitle, 72)}`,
      detail: oneLine(unquote(args.Prompt || ''), 120),
      commandLine: '',
      role: subTitle,
      typeName,
      model: localizeModelName(unquote(args.Model || '')),
      requestFeedback: false,
    };
  }
  if (name === 'ask_question') {
    let qText = '';
    let qs = args.questions;
    if (typeof qs === 'string') {
      try { qs = JSON.parse(qs); } catch { qs = null; }
    }
    if (Array.isArray(qs) && qs[0]?.question) qText = String(qs[0].question);
    return {
      name,
      label: '等待你选择回答问题',
      detail: oneLine(qText, 120),
      commandLine: '',
      requestFeedback: true,
    };
  }
  if (path) {
    const verbMap = {
      read_file: '读取',
      write_file: requestFeedback ? '提交方案待审阅' : '写入',
      edit_file: requestFeedback ? '更新方案待审阅' : '编辑',
    };
    const verb = verbMap[name] || zhTool;
    return {
      name,
      label: `${verb} ${basename(path)}`,
      detail: path,
      commandLine: '',
      path,
      requestFeedback,
    };
  }
  if ((name === 'search_web' || name === 'code_search' || name === 'search_marketplace') && query) {
    return {
      name,
      label: `${zhTool}：${oneLine(query, 72)}`,
      detail: query,
      commandLine: '',
      requestFeedback: false,
    };
  }
  if (name === 'call_mcp_tool') {
    const srv = unquote(args.ServerName || '');
    const tl = unquote(args.ToolName || '');
    return {
      name,
      label: `调用扩展工具：${oneLine([srv, tl].filter(Boolean).join('/'), 70) || '外部服务'}`,
      detail: '',
      commandLine: '',
      requestFeedback: false,
    };
  }
  if (name === 'swarm') {
    const actMap = { add: '新增成员', status: '查询状态', models: '查询模型', kill: '结束成员', model: '切换模型', title: '设置标题' };
    const act = actMap[unquote(args.action || '')] || unquote(args.action || '');
    const target = unquote(args.name || '');
    return {
      name,
      label: oneLine(`群组协作：${act} ${target}`.trim(), 80),
      detail: oneLine(unquote(args.brief || ''), 120),
      commandLine: '',
      requestFeedback: false,
    };
  }
  return {
    name,
    label: zhTool,
    detail: summary ? oneLine(summary, 90) : '',
    commandLine: '',
    requestFeedback,
  };
}

/**
 * 解析阶段清单文档中的勾选进度（`- [ ]`、`- [/]`、`- [x]`）。
 */
export function parseMilestoneMarkdown(markdownText, sourceName = '任务清单', filePath = '') {
  if (typeof markdownText !== 'string' || !markdownText.trim()) return null;
  const items = [];
  const lines = markdownText.split(/\r?\n/);
  let headingTitle = '';

  for (const rawLine of lines) {
    if (!headingTitle) {
      const hm = /^#{1,2}\s+(.+)$/.exec(rawLine.trim());
      if (hm) headingTitle = oneLine(hm[1], 80);
    }
    const m = /^(\s*)[-*+]\s+\[([ xX\/\-])\]\s+(.+)$/.exec(rawLine);
    if (!m) continue;
    const indent = Math.floor((m[1] || '').replace(/\t/g, '  ').length / 2);
    const mark = m[2];
    const state = (mark === 'x' || mark === 'X')
      ? 'done'
      : ((mark === '/' || mark === '-') ? 'active' : 'pending');
    const text = oneLine(m[3], 100);
    if (!text) continue;
    items.push({ state, text, indent });
  }

  if (!items.length) return null;

  const topLevel = items.filter((it) => it.indent === 0);
  const pool = topLevel.length >= 2 ? topLevel : items;

  const total = pool.length;
  const done = pool.filter((it) => it.state === 'done').length;
  const activeItems = items.filter((it) => it.state === 'active');
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  let currentItem = activeItems[0] || null;
  if (!currentItem && done < total) {
    currentItem = pool.find((it) => it.state === 'pending') || null;
  }

  return {
    title: headingTitle || sourceName,
    sourceName,
    filePath,
    total,
    done,
    activeCount: activeItems.length,
    percent,
    currentText: currentItem ? currentItem.text : (done === total ? '全部阶段已完成' : ''),
    items: items.slice(0, 24),
  };
}

/**
 * 解析系统进程表并聚合整棵子进程树的处理器占用率。
 */
export function parsePsOutput(psText) {
  if (typeof psText !== 'string' || !psText.trim()) return [];
  const rows = [];
  for (const line of psText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.+)$/.exec(trimmed);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      cpu: Number(m[3]) || 0,
      etime: m[4],
      command: m[5],
    });
  }
  return rows;
}

export function matchActiveProcess(psRows, { commandLine = '', workspacePaths = [], ownPid = -1 } = {}) {
  if (!Array.isArray(psRows) || !psRows.length) return null;
  const cmdTrimmed = String(commandLine || '').trim();
  if (!cmdTrimmed) return null;

  const childrenMap = new Map();
  const byPid = new Map();
  for (const r of psRows) {
    byPid.set(r.pid, r);
    if (!childrenMap.has(r.ppid)) childrenMap.set(r.ppid, []);
    childrenMap.get(r.ppid).push(r.pid);
  }

  function subtreeStats(rootPid, visited = new Set()) {
    if (visited.has(rootPid)) return { cpu: 0, count: 0, leafCmd: '' };
    visited.add(rootPid);
    const node = byPid.get(rootPid);
    let cpu = node ? node.cpu : 0;
    let count = node ? 1 : 0;
    let leafCmd = node ? node.command : '';
    for (const childPid of childrenMap.get(rootPid) || []) {
      const sub = subtreeStats(childPid, visited);
      cpu += sub.cpu;
      count += sub.count;
      if (sub.leafCmd) leafCmd = sub.leafCmd;
    }
    return { cpu, count, leafCmd };
  }

  const stripQuotes = (s) => String(s || '').replace(/['"`]/g, ' ').replace(/\s+/g, ' ').trim();
  const normalizedNeedle = stripQuotes(cmdTrimmed).slice(0, 44);
  const firstSegment = stripQuotes(cmdTrimmed.split(/[;&|\r\n]/)[0]).slice(0, 36);

  const candidates = [];
  for (const r of psRows) {
    if (r.pid === ownPid || r.ppid === ownPid) continue;
    if (r.command.includes('session_monitor') || r.command.includes('hook_collector.mjs')) continue;
    if (r.command.startsWith('ps -axo')) continue;

    const cmdNorm = stripQuotes(r.command);
    const directHit = (normalizedNeedle.length >= 4 && cmdNorm.includes(normalizedNeedle))
      || (firstSegment.length >= 5 && cmdNorm.includes(firstSegment));
    const wsHit = !directHit && Array.isArray(workspacePaths) && workspacePaths.some(
      (ws) => typeof ws === 'string' && ws.length > 5 && cmdNorm.includes(ws),
    );

    if (directHit || wsHit) {
      const sub = subtreeStats(r.pid);
      candidates.push({
        pid: r.pid,
        cpu: Math.round(sub.cpu * 10) / 10,
        processCount: sub.count,
        etime: r.etime,
        command: oneLine(sub.leafCmd || r.command, 90),
        directHit,
      });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => (Number(b.directHit) - Number(a.directHit)) || (b.cpu - a.cpu));
  return candidates[0];
}

const EMPTY_TOKEN_SPEED = Object.freeze({
  latestTps: null,
  latestOutTokens: 0,
  latestGenSec: null,
  turnAvgTps: null,
  sessionAvgTps: null,
  avgTps: null,
  peakTps: null,
  measuredRounds: 0,
});

/**
 * 解析会话紧凑日志 `transcript.jsonl`，生成执行轮次、词元统计、生成速度、子代理与待完成动作。
 */
export function parseTranscript(text, transcriptMtimeMs = 0, hookState = null) {
  const empty = {
    stepCount: 0,
    stepsSinceCompact: 0,
    compactCount: 0,
    lastCompactAtMs: null,
    titleCandidate: '',
    turnStartedAtMs: null,
    lastStepAtMs: transcriptMtimeMs || null,
    modelId: '',
    tokens: { input: 0, cache: 0, output: 0, currentContext: 0 },
    tokenSpeed: { ...EMPTY_TOKEN_SPEED },
    avgThinkingMs: null,
    rounds: [],
    subagentRefs: [],
    bgTasks: [],
    pendingTools: [],
    pendingStartedAtMs: null,
    lastPlannerRequestFeedback: false,
    lastPlannerHasNoTools: false,
    latestErrorStep: null,
    turnIdleByTranscript: true,
  };
  if (typeof text !== 'string' || !text.trim()) return empty;

  const hookEvents = Array.isArray(hookState?.recentHookEvents) ? hookState.recentHookEvents : [];
  const hookStopAtMs = Number(hookState?.stop?.stoppedAt) || 0;

  const steps = [];
  for (const rawLine of text.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') steps.push(obj);
    } catch {
      // 末尾行正在写入时安全跳过，下一轮轮询完整读取
    }
  }
  if (!steps.length) return empty;

  let stepCount = steps.length;
  const lastStepObj = steps[steps.length - 1];
  if (Number.isFinite(lastStepObj.step_index)) {
    stepCount = Math.max(stepCount, lastStepObj.step_index + 1);
  }

  let titleCandidate = '';
  let turnStartedAtMs = null;
  let lastUserStepIdx = -1;
  let lastCompactIdx = -1;
  let compactCount = 0;
  let lastCompactAtMs = null;
  let totalInput = 0;
  let totalCache = 0;
  let totalOutput = 0;
  let currentContext = 0;

  const thinkingSamples = [];
  const rounds = [];
  const subagentMap = new Map();
  const bgTaskMap = new Map();

  let prevTimestampMs = null;

  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    const stMs = parseIsoMs(st.created_at) || prevTimestampMs;
    if (stMs) prevTimestampMs = stMs;

    if (st.type === 'CHECKPOINT') {
      compactCount += 1;
      lastCompactIdx = i;
      lastCompactAtMs = stMs || transcriptMtimeMs || null;
      // 压缩检查点落盘后，旧上下文已被折叠释放，重置当前活跃水位等待下一轮规划回报新值
      currentContext = 0;
      rounds.push({
        kind: 'compact',
        roundNum: rounds.length + 1,
        stepIndex: st.step_index ?? i,
        startedAtMs: stMs,
        endedAtMs: stMs,
        thinkingMs: 0,
        toolsMs: 0,
        totalMs: 0,
        title: `已完成上下文压缩（第 ${compactCount} 次）`,
        tools: [],
        inCurrentTurn: i > lastUserStepIdx,
      });
      continue;
    }

    if (st.type === 'USER_INPUT') {
      const promptText = extractUserPrompt(st.content);
      if (promptText && (!titleCandidate || (titleCandidate.length < 6 && promptText.length >= 6))) {
        titleCandidate = promptText;
      }
      turnStartedAtMs = stMs || transcriptMtimeMs || Date.now();
      lastUserStepIdx = i;
      continue;
    }

    if (bgTaskMap.size > 0 && typeof st.content === 'string') {
      for (const [tid, task] of bgTaskMap.entries()) {
        if (task.status === 'running' && st.content.includes(tid)) {
          task.status = 'completed';
        }
      }
    }

    if (st.type === 'ERROR_MESSAGE') {
      const errText = localizeErrorText(st.error || st.content || '模型或网络接口请求异常');
      rounds.push({
        kind: 'error',
        roundNum: rounds.length + 1,
        stepIndex: st.step_index ?? i,
        startedAtMs: stMs,
        endedAtMs: stMs,
        thinkingMs: 0,
        toolsMs: 0,
        totalMs: 0,
        title: '接口或流式传输中断',
        error: errText,
        tools: [],
        inCurrentTurn: i > lastUserStepIdx,
      });
      continue;
    }

    if (st.type !== 'PLANNER_RESPONSE') continue;

    const inTok = Number(st.input_tokens) || 0;
    const cacheTok = Number(st.cache_read_tokens) || 0;
    const outTok = Number(st.output_tokens) || 0;
    totalInput += inTok;
    totalCache += cacheTok;
    totalOutput += outTok;
    if (inTok + cacheTok > 0) currentContext = inTok + cacheTok;

    const rawCalls = Array.isArray(st.tool_calls) ? st.tool_calls : [];
    const describedCalls = rawCalls.map((tc) => describeToolCall(tc));

    const genericResults = [];
    let j = i + 1;
    while (j < steps.length && steps[j].type === 'GENERIC' && genericResults.length < describedCalls.length) {
      genericResults.push(steps[j]);
      j++;
    }
    // 关键修复：如果后面已经出现了新的步骤（例如流中断 ERROR_MESSAGE、新的用户输入或新一轮规划），
    // 说明当前批次未返回的工具调用已被中断取消，绝不能继续当作仍在执行中的 PENDING 工具！
    const batchAbortedByLaterStep = j < steps.length;

    const plannerCreatedMs = parseIsoMs(st.created_at) || prevTimestampMs;
    let firstToolStartMs = null;
    let lastToolEndMs = null;

    const toolEntries = describedCalls.map((dc, idx) => {
      const resStep = genericResults[idx];
      if (!resStep) {
        return {
          ...dc,
          status: batchAbortedByLaterStep ? 'INTERRUPTED' : 'PENDING',
          durationMs: null,
          error: batchAbortedByLaterStep ? '该步骤执行途中因流传输中断而未完成' : '',
        };
      }
      const { startedAtMs, completedAtMs } = parseGenericTimestamps(resStep.content);
      const resCreatedMs = parseIsoMs(resStep.created_at);
      const tStart = startedAtMs || resCreatedMs || plannerCreatedMs;
      const tEnd = completedAtMs || resCreatedMs || tStart;
      if (tStart && (!firstToolStartMs || tStart < firstToolStartMs)) firstToolStartMs = tStart;
      if (tEnd && (!lastToolEndMs || tEnd > lastToolEndMs)) lastToolEndMs = tEnd;

      if (dc.name === 'invoke_subagent' && typeof resStep.content === 'string') {
        const subMatch = /"conversationId"\s*:\s*"([0-9a-fA-F-]{8,64})"/.exec(resStep.content);
        if (subMatch) {
          subagentMap.set(subMatch[1], {
            conversationId: subMatch[1],
            role: dc.role || SUBAGENT_TYPE_ZH[dc.typeName] || '子代理',
            typeName: dc.typeName || 'subagent',
            model: dc.model || '',
            stepIndex: st.step_index ?? i,
            startedAtMs: tStart,
          });
        }
      }

      if (resStep.status === 'RUNNING' && typeof resStep.content === 'string') {
        const bgMatch = /task id:\s*([^\s\r\n]+)/i.exec(resStep.content);
        const taskId = bgMatch ? bgMatch[1] : `步骤-${resStep.step_index ?? idx}`;
        bgTaskMap.set(taskId, {
          taskId,
          description: dc.label || dc.commandLine || '后台任务',
          startedAtMs: tStart || Date.now(),
          status: 'running',
        });
      }

      const status = String(resStep.status || 'DONE');
      const errSnippet = status === 'ERROR'
        ? oneLine(resStep.error || resStep.content || '工具执行失败', 160)
        : '';

      return {
        ...dc,
        status,
        startedAtMs: tStart,
        endedAtMs: tEnd,
        durationMs: (tStart && tEnd && tEnd >= tStart) ? (tEnd - tStart) : null,
        error: errSnippet,
      };
    });

    const thinkingMs = (plannerCreatedMs && firstToolStartMs && firstToolStartMs >= plannerCreatedMs)
      ? (firstToolStartMs - plannerCreatedMs)
      : null;
    if (thinkingMs != null && thinkingMs >= 200 && thinkingMs < 600_000) {
      thinkingSamples.push(thinkingMs);
    }

    // 计算本轮模型 Token 生成耗时与生成速率（Token/秒）
    let genMs = null;
    if (outTok > 0 && plannerCreatedMs) {
      if (firstToolStartMs && firstToolStartMs >= plannerCreatedMs) {
        genMs = Math.max(800, firstToolStartMs - plannerCreatedMs);
      } else {
        for (let k = 0; k < hookEvents.length; k++) {
          const ev = hookEvents[k];
          if (ev?.event === 'PreInvocation' && Math.abs((ev.ts || 0) - plannerCreatedMs) <= 3000) {
            const nextEv = hookEvents[k + 1];
            if (nextEv?.event === 'Stop' && nextEv.ts > ev.ts) {
              genMs = Math.max(200, nextEv.ts - ev.ts);
            }
            break;
          }
        }
        if (genMs == null && i + 1 < steps.length && steps[i + 1].type === 'ERROR_MESSAGE') {
          const errMs = parseIsoMs(steps[i + 1].created_at);
          if (errMs && errMs >= plannerCreatedMs) {
            genMs = Math.max(800, errMs - plannerCreatedMs);
          }
        }
        if (genMs == null && i === steps.length - 1) {
          const endCandidate = (hookStopAtMs && hookStopAtMs >= plannerCreatedMs)
            ? hookStopAtMs
            : ((transcriptMtimeMs && transcriptMtimeMs >= plannerCreatedMs) ? transcriptMtimeMs : 0);
          if (endCandidate > 0 && endCandidate - plannerCreatedMs <= 600_000) {
            genMs = Math.max(800, endCandidate - plannerCreatedMs);
          }
        }
      }
      if (genMs != null && (genMs < 200 || genMs > 600_000)) {
        genMs = null;
      }
    }
    const roundTps = (outTok > 0 && genMs != null)
      ? Math.round((outTok / (genMs / 1000)) * 10) / 10
      : null;

    const toolsMs = (firstToolStartMs && lastToolEndMs && lastToolEndMs >= firstToolStartMs)
      ? (lastToolEndMs - firstToolStartMs)
      : null;
    const endedAtMs = lastToolEndMs || firstToolStartMs || (genMs != null && plannerCreatedMs ? plannerCreatedMs + genMs : plannerCreatedMs);
    const totalMs = (plannerCreatedMs && endedAtMs && endedAtMs >= plannerCreatedMs)
      ? (endedAtMs - plannerCreatedMs)
      : null;

    if (endedAtMs) prevTimestampMs = endedAtMs;

    const heading = thinkingHeading(st.thinking);
    const hasChineseInHeading = /[\u4e00-\u9fff]/.test(heading);
    const primaryToolLabel = toolEntries[0]?.label || '';
    const roundTitle = (hasChineseInHeading && heading)
      ? heading
      : (primaryToolLabel || '输出本轮回复结论');

    rounds.push({
      kind: 'planner',
      roundNum: rounds.length + 1,
      stepIndex: st.step_index ?? i,
      startedAtMs: plannerCreatedMs,
      endedAtMs,
      thinkingMs,
      genMs,
      tps: roundTps,
      toolsMs,
      totalMs,
      title: roundTitle,
      hasReplyText: Boolean(typeof st.content === 'string' && st.content.trim()),
      tools: toolEntries,
      tokens: { in: inTok, cache: cacheTok, out: outTok },
      hasError: toolEntries.some((t) => t.status === 'ERROR'),
      inCurrentTurn: i > lastUserStepIdx,
    });
  }

  let latestErrorStep = null;
  if (lastStepObj.type === 'ERROR_MESSAGE') {
    latestErrorStep = {
      error: localizeErrorText(lastStepObj.error || lastStepObj.content || '接口请求异常'),
      atMs: parseIsoMs(lastStepObj.created_at) || transcriptMtimeMs,
    };
  }

  const lastPlannerRound = [...rounds].reverse().find((r) => r.kind === 'planner') || null;
  const pendingTools = lastPlannerRound
    ? lastPlannerRound.tools.filter((t) => t.status === 'PENDING')
    : [];

  let pendingStartedAtMs = null;
  if (pendingTools.length && lastPlannerRound) {
    const completedInBatch = lastPlannerRound.tools.filter((t) => t.status !== 'PENDING' && t.endedAtMs);
    pendingStartedAtMs = completedInBatch.length
      ? completedInBatch[completedInBatch.length - 1].endedAtMs
      : (transcriptMtimeMs || lastPlannerRound.startedAtMs);
  }

  const lastPlannerRequestFeedback = Boolean(
    lastPlannerRound && lastPlannerRound.tools.some((t) => t.requestFeedback && t.name !== 'ask_question'),
  );
  const lastPlannerHasNoTools = Boolean(
    lastPlannerRound && lastPlannerRound.tools.length === 0 && lastStepObj.type === 'PLANNER_RESPONSE',
  );

  let turnIdleByTranscript = false;
  if (lastStepObj.type === 'PLANNER_RESPONSE' && (!Array.isArray(lastStepObj.tool_calls) || lastStepObj.tool_calls.length === 0)) {
    turnIdleByTranscript = true;
  } else if (lastPlannerRound && pendingTools.length === 0) {
    const hasSwarmWaitDone = lastPlannerRound.tools.some((t) => t.name === 'swarm_wait' && t.status === 'DONE');
    if (hasSwarmWaitDone || lastPlannerRequestFeedback) {
      turnIdleByTranscript = true;
    }
  }

  const avgThinkingMs = thinkingSamples.length
    ? Math.round(thinkingSamples.reduce((a, b) => a + b, 0) / thinkingSamples.length)
    : null;

  // 汇总任务级 Token 生成速度指标（最新速率 / 当前轮次加权均值 / 全局加权均值 / 峰值）
  const measuredPlannerRounds = rounds.filter((r) => r.kind === 'planner' && r.tps != null && r.genMs > 0);
  let tokenSpeed = { ...EMPTY_TOKEN_SPEED };
  if (measuredPlannerRounds.length > 0) {
    const lastMeasured = measuredPlannerRounds[measuredPlannerRounds.length - 1];
    let allOut = 0;
    let allGenMs = 0;
    let turnOut = 0;
    let turnGenMs = 0;
    let peak = 0;
    for (const mr of measuredPlannerRounds) {
      allOut += mr.tokens.out;
      allGenMs += mr.genMs;
      if (mr.inCurrentTurn) {
        turnOut += mr.tokens.out;
        turnGenMs += mr.genMs;
      }
      if (mr.tps > peak) peak = mr.tps;
    }
    const sessionAvgTps = allGenMs > 0 ? Math.round((allOut / (allGenMs / 1000)) * 10) / 10 : null;
    const turnAvgTps = turnGenMs > 0 ? Math.round((turnOut / (turnGenMs / 1000)) * 10) / 10 : null;
    tokenSpeed = {
      latestTps: lastMeasured.tps,
      latestOutTokens: lastMeasured.tokens.out,
      latestGenSec: Math.round((lastMeasured.genMs / 1000) * 10) / 10,
      turnAvgTps,
      sessionAvgTps,
      avgTps: turnAvgTps ?? sessionAvgTps,
      peakTps: peak || null,
      measuredRounds: measuredPlannerRounds.length,
    };
  }

  const stepsSinceCompact = lastCompactIdx >= 0
    ? Math.max(0, steps.length - 1 - lastCompactIdx)
    : stepCount;

  return {
    stepCount,
    stepsSinceCompact,
    compactCount,
    lastCompactAtMs,
    titleCandidate,
    turnStartedAtMs,
    lastStepAtMs: Math.max(prevTimestampMs || 0, transcriptMtimeMs || 0) || null,
    tokens: {
      input: totalInput,
      cache: totalCache,
      output: totalOutput,
      currentContext,
    },
    tokenSpeed,
    avgThinkingMs,
    rounds,
    subagentRefs: [...subagentMap.values()],
    bgTasks: [...bgTaskMap.values()],
    pendingTools,
    pendingStartedAtMs,
    lastPlannerRequestFeedback,
    lastPlannerHasNoTools,
    latestErrorStep,
    turnIdleByTranscript,
  };
}

const QUOTA_RE = /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit/i;
const STALE_UNHOOKED_MS = 20 * 60 * 1000;
const STALE_FEEDBACK_MS = 30 * 60 * 1000;

/**
 * 综合钩子快照、对话日志、子代理状态与系统子进程占用率，输出 6 态健康诊断结果。
 */
export function evaluateConversationHealth({
  now = Date.now(),
  hookState = null,
  transcript = null,
  subagents = [],
  proc = null,
  settings: rawSettings = DEFAULT_SETTINGS,
} = {}) {
  const settings = normalizeSettings(rawSettings);
  const tr = transcript || parseTranscript('');
  const hook = hookState && typeof hookState === 'object' ? hookState : null;

  const modelName = localizeModelName(hook?.modelName || '');
  const invocationNum = hook?.invocationNum || tr.rounds.filter((r) => r.kind === 'planner' && r.inCurrentTurn).length || 0;
  const turnStart = hook?.turnStartedAt || tr.turnStartedAtMs || null;
  const latestActivityMs = Math.max(hook?.updatedAt || 0, tr.lastStepAtMs || 0);

  if (!hook && !proc && latestActivityMs > 0 && now - latestActivityMs > STALE_UNHOOKED_MS) {
    return {
      state: 'IDLE',
      badge: '已归档/待命',
      severity: 'idle',
      headline: tr.rounds[tr.rounds.length - 1]?.title || tr.titleCandidate || '历史会话已静置',
      detail: `累计 ${tr.stepCount} 步 · 已静置超过 20 分钟`,
      elapsedSec: 0,
      startedAtMs: latestActivityMs,
      turnStartedAtMs: turnStart,
      modelName,
      invocationNum,
      process: null,
      alertKey: null,
    };
  }

  const activeSubagents = subagents.filter((s) => s.isRunning);
  const erroredSubagent = subagents.find((s) => s.state === 'ERROR_STOPPED' || s.state === 'STUCK_SUSPECTED');

  const runningBgTasks = (hook?.phase === 'stopped' && hook?.stop?.fullyIdle)
    ? []
    : tr.bgTasks.filter((b) => b.status === 'running');

  const hookStopped = hook?.phase === 'stopped' && hook?.stop?.stoppedAt
    && (!tr.turnStartedAtMs || hook.stop.stoppedAt >= tr.turnStartedAtMs - 1000);

  // 1. 检查当前轮次尚未返回的工具调用
  if (!hookStopped && tr.pendingTools.length > 0) {
    const primaryTool = tr.pendingTools[0];
    const startedAt = tr.pendingStartedAtMs || hook?.updatedAt || now;
    const elapsedSec = Math.max(0, Math.round((now - startedAt) / 1000));

    if (primaryTool.name === 'ask_question') {
      return {
        state: 'WAITING_USER',
        badge: '等待你回答',
        severity: 'action_required',
        headline: primaryTool.label,
        detail: primaryTool.detail || '请在左侧对话窗选择或输入你的回答以继续执行',
        elapsedSec,
        startedAtMs: startedAt,
        turnStartedAtMs: turnStart,
        modelName,
        invocationNum,
        process: null,
        alertKey: `waiting-question-${tr.stepCount}`,
      };
    }

    if (primaryTool.name === 'run_command') {
      if (proc && proc.cpu > 0.5) {
        return {
          state: 'TOOL_ACTIVE',
          badge: '命令活跃运行',
          severity: 'healthy',
          headline: primaryTool.label,
          detail: `进程号 ${proc.pid} · 占用 ${proc.cpu.toFixed(1)}% · ${primaryTool.detail || proc.command}`,
          elapsedSec,
          startedAtMs: startedAt,
          turnStartedAtMs: turnStart,
          modelName,
          invocationNum,
          process: proc,
          alertKey: null,
        };
      }

      if (!proc && elapsedSec >= settings.approvalHintSec) {
        return {
          state: 'WAITING_USER',
          badge: '等待权限确认',
          severity: 'action_required',
          headline: `待确认命令：${primaryTool.label}`,
          detail: `已等待 ${elapsedSec}s 尚未拉起子进程，请检查左侧对话窗是否有命令执行确认弹窗`,
          elapsedSec,
          startedAtMs: startedAt,
          turnStartedAtMs: turnStart,
          modelName,
          invocationNum,
          process: null,
          alertKey: `waiting-approval-${tr.stepCount}`,
        };
      }

      if (elapsedSec >= settings.commandQuietStuckSec) {
        return {
          state: 'STUCK_SUSPECTED',
          badge: '命令疑似挂起',
          severity: 'warning',
          headline: primaryTool.label,
          detail: proc
            ? `进程号 ${proc.pid}（占用 ${proc.cpu.toFixed(1)}%）已静默 ${elapsedSec}s，可能卡在交互输入或死锁`
            : `命令已逾 ${elapsedSec}s 无输出响应，可能挂起或阻塞`,
          elapsedSec,
          startedAtMs: startedAt,
          turnStartedAtMs: turnStart,
          modelName,
          invocationNum,
          process: proc,
          alertKey: `stuck-cmd-${tr.stepCount}`,
        };
      }

      return {
        state: 'TOOL_ACTIVE',
        badge: '命令执行中',
        severity: 'healthy',
        headline: primaryTool.label,
        detail: proc
          ? `进程号 ${proc.pid} · 占用 ${proc.cpu.toFixed(1)}% · ${primaryTool.detail}`
          : (primaryTool.detail || '正在运行终端命令…'),
        elapsedSec,
        startedAtMs: startedAt,
        turnStartedAtMs: turnStart,
        modelName,
        invocationNum,
        process: proc,
        alertKey: null,
      };
    }

    const zhToolName = TOOL_NAME_ZH[primaryTool.name] || '工具';
    if (elapsedSec >= settings.commandQuietStuckSec) {
      return {
        state: 'STUCK_SUSPECTED',
        badge: '工具响应超时',
        severity: 'warning',
        headline: primaryTool.label,
        detail: `${zhToolName}已执行 ${elapsedSec}s 仍未返回，可能正在等待确认或外部服务无响应`,
        elapsedSec,
        startedAtMs: startedAt,
        turnStartedAtMs: turnStart,
        modelName,
        invocationNum,
        process: null,
        alertKey: `stuck-tool-${tr.stepCount}`,
      };
    }

    return {
      state: 'TOOL_ACTIVE',
      badge: tr.pendingTools.length > 1 ? `并发执行 ${tr.pendingTools.length} 项操作` : '工具执行中',
      severity: 'healthy',
      headline: primaryTool.label,
      detail: primaryTool.detail || `正在执行${zhToolName}`,
      elapsedSec,
      startedAtMs: startedAt,
      turnStartedAtMs: turnStart,
      modelName,
      invocationNum,
      process: null,
      alertKey: null,
    };
  }

  // 2. 检查结束钩子与终止异常
  if (hookStopped && hook.stop) {
    const reason = hook.stop.terminationReason || 'NO_TOOL_CALL';
    const zhReason = TERMINATION_REASON_ZH[reason] || reason;
    if (reason === 'ERROR' || reason === 'MAX_TOKEN_BUDGET_EXCEEDED' || reason === 'MAX_INVOCATIONS') {
      const errDetail = hook.stop.error || tr.latestErrorStep?.error || zhReason;
      const isQuota = QUOTA_RE.test(errDetail);
      return {
        state: 'ERROR_STOPPED',
        badge: isQuota ? '配额/限流中断' : '异常中断',
        severity: 'danger',
        headline: isQuota ? '模型配额耗尽或请求速率受限' : `执行因异常终止（${zhReason}）`,
        detail: errDetail,
        elapsedSec: 0,
        startedAtMs: hook.stop.stoppedAt,
        turnStartedAtMs: turnStart,
        turnDurationSec: turnStart ? Math.max(0, Math.round((hook.stop.stoppedAt - turnStart) / 1000)) : 0,
        modelName,
        invocationNum,
        process: null,
        alertKey: `err-stop-${hook.stop.stoppedAt}`,
      };
    }

    if (tr.lastPlannerRequestFeedback && (now - hook.stop.stoppedAt <= STALE_FEEDBACK_MS)) {
      return {
        state: 'WAITING_USER',
        badge: '等待审阅方案',
        severity: 'action_required',
        headline: '文档或方案已就绪，等待你点击继续或提出修改意见',
        detail: '智能体已暂停执行，正在等待你审阅确认最新生成的方案文档',
        elapsedSec: Math.max(0, Math.round((now - hook.stop.stoppedAt) / 1000)),
        startedAtMs: hook.stop.stoppedAt,
        turnStartedAtMs: turnStart,
        modelName,
        invocationNum,
        process: null,
        alertKey: `waiting-artifact-${tr.stepCount}`,
      };
    }

    if (activeSubagents.length > 0 || runningBgTasks.length > 0) {
      if (erroredSubagent) {
        return {
          state: 'STUCK_SUSPECTED',
          badge: '子代理异常/卡住',
          severity: 'warning',
          headline: `子代理【${erroredSubagent.role}】${erroredSubagent.badge}`,
          detail: erroredSubagent.detail || erroredSubagent.headline,
          elapsedSec: erroredSubagent.elapsedSec || 0,
          startedAtMs: erroredSubagent.startedAtMs || now,
          turnStartedAtMs: turnStart,
          modelName,
          invocationNum,
          process: null,
          alertKey: `subagent-issue-${erroredSubagent.conversationId}-${erroredSubagent.state}`,
        };
      }
      const lead = activeSubagents[0];
      return {
        state: 'SUBAGENT_RUNNING',
        badge: activeSubagents.length > 0
          ? `${activeSubagents.length} 个子代理运行中`
          : `${runningBgTasks.length} 个后台任务运行中`,
        severity: 'healthy',
        headline: lead
          ? `【${lead.role}】${lead.headline}`
          : runningBgTasks[0].description,
        detail: lead
          ? `${lead.badge} · 已执行 ${lead.stepCount} 步`
          : '主会话正在等待后台任务完成后自动唤醒',
        elapsedSec: lead ? lead.elapsedSec : Math.max(0, Math.round((now - runningBgTasks[0].startedAtMs) / 1000)),
        startedAtMs: lead?.startedAtMs || runningBgTasks[0]?.startedAtMs || now,
        turnStartedAtMs: turnStart,
        modelName,
        invocationNum,
        process: null,
        alertKey: null,
      };
    }

    const totalTurnSec = turnStart
      ? Math.max(0, Math.round((hook.stop.stoppedAt - turnStart) / 1000))
      : 0;
    const isCanceled = reason === 'USER_CANCELED';

    const lastToolRoundInTurn = [...tr.rounds]
      .reverse()
      .find((r) => r.kind === 'planner' && r.inCurrentTurn && r.tools?.length > 0);
    const completedSummary = lastToolRoundInTurn?.tools?.[0]?.label
      ? `最近操作：${lastToolRoundInTurn.tools[0].label}`
      : '本轮执行已正常结束，等待新指令';

    return {
      state: isCanceled ? 'IDLE' : 'COMPLETED',
      badge: isCanceled ? '已手动停止' : '已完成',
      severity: 'idle',
      headline: isCanceled ? '任务已手动取消' : completedSummary,
      detail: '',
      elapsedSec: 0,
      startedAtMs: hook.stop.stoppedAt,
      turnStartedAtMs: turnStart,
      turnDurationSec: totalTurnSec,
      modelName,
      invocationNum,
      process: null,
      alertKey: null,
    };
  }

  // 3. 检查模型是否处于推理思考中
  const isThinkingByHook = hook?.phase === 'thinking'
    && hook.invocationStartedAt
    && (!tr.lastStepAtMs || hook.invocationStartedAt >= tr.lastStepAtMs - 2000 || !tr.turnIdleByTranscript);
  const isThinkingByTranscript = !hook && !tr.turnIdleByTranscript && tr.stepCount > 0;

  if (isThinkingByHook || isThinkingByTranscript || (hook?.phase === 'post_tool' && !hookStopped)) {
    const thinkStart = hook?.invocationStartedAt || hook?.lastTool?.finishedAt || tr.lastStepAtMs || now;
    const elapsedSec = Math.max(0, Math.round((now - thinkStart) / 1000));

    if (tr.latestErrorStep && (!thinkStart || tr.latestErrorStep.atMs >= thinkStart - 5000)) {
      const sinceErrSec = tr.latestErrorStep.atMs
        ? Math.max(0, Math.round((now - tr.latestErrorStep.atMs) / 1000))
        : elapsedSec;
      const newerInvocationStarted = Boolean(
        hook?.invocationStartedAt && tr.latestErrorStep.atMs && hook.invocationStartedAt > tr.latestErrorStep.atMs + 1500,
      );
      if (!newerInvocationStarted && sinceErrSec >= 12) {
        const isQuota = QUOTA_RE.test(tr.latestErrorStep.error);
        return {
          state: 'ERROR_STOPPED',
          badge: isQuota ? '配额/限流中断' : '流传输中断',
          severity: 'danger',
          headline: isQuota ? '模型配额耗尽或请求速率受限' : '模型响应流中断，可一键唤醒继续执行',
          detail: tr.latestErrorStep.error,
          elapsedSec: 0,
          startedAtMs: tr.latestErrorStep.atMs || thinkStart,
          turnStartedAtMs: turnStart,
          turnDurationSec: turnStart && tr.latestErrorStep.atMs
            ? Math.max(0, Math.round((tr.latestErrorStep.atMs - turnStart) / 1000))
            : 0,
          modelName,
          invocationNum,
          process: null,
          alertKey: `err-stream-${tr.stepCount}`,
        };
      }
      return {
        state: 'RETRYING',
        badge: '接口波动重试中',
        severity: 'warning',
        headline: '检测到模型接口连接异常，正在等待自动重连…',
        detail: tr.latestErrorStep.error,
        elapsedSec,
        startedAtMs: thinkStart,
        turnStartedAtMs: turnStart,
        modelName,
        invocationNum,
        process: null,
        alertKey: elapsedSec >= settings.thinkingStuckSec ? `retry-stuck-${tr.stepCount}` : null,
      };
    }

    const avgHint = tr.avgThinkingMs
      ? `历史单轮均值约 ${Math.max(1, Math.round(tr.avgThinkingMs / 1000))}s`
      : '正在规划下一步操作或组织回复内容';

    if (elapsedSec >= settings.thinkingStuckSec) {
      return {
        state: 'STUCK_SUSPECTED',
        badge: '模型响应超时',
        severity: 'warning',
        headline: `第 ${invocationNum || 1} 轮模型推理已逾 ${formatDurationShort(elapsedSec)}`,
        detail: '已远超正常响应时长，可能遇到网络静默断流或服务端拥塞',
        elapsedSec,
        startedAtMs: thinkStart,
        turnStartedAtMs: turnStart,
        modelName,
        invocationNum,
        process: null,
        alertKey: `stuck-thinking-${invocationNum}-${thinkStart}`,
      };
    }

    if (elapsedSec >= settings.thinkingWarnSec) {
      return {
        state: 'THINKING_DEEP',
        badge: '深度推理中',
        severity: 'caution',
        headline: `模型正在深度长思考（第 ${invocationNum || 1} 轮）`,
        detail: `${modelName ? `${modelName} · ` : ''}高推理模型处理复杂架构拆解耗时 1～3 分钟属正常现象`,
        elapsedSec,
        startedAtMs: thinkStart,
        turnStartedAtMs: turnStart,
        modelName,
        invocationNum,
        process: null,
        alertKey: null,
      };
    }

    return {
      state: 'THINKING',
      badge: '模型思考中',
      severity: 'healthy',
      headline: `正在思考与规划（第 ${invocationNum || 1} 轮）`,
      detail: `${modelName ? `${modelName} · ` : ''}${avgHint}`,
      elapsedSec,
      startedAtMs: thinkStart,
      turnStartedAtMs: turnStart,
      modelName,
      invocationNum,
      process: null,
      alertKey: null,
    };
  }

  // 4. 纯日志兜底分支
  if (tr.lastPlannerRequestFeedback && (!tr.lastStepAtMs || now - tr.lastStepAtMs <= STALE_FEEDBACK_MS)) {
    return {
      state: 'WAITING_USER',
      badge: '等待审阅方案',
      severity: 'action_required',
      headline: '方案文档已生成，等待你审阅确认',
      detail: '点击文档上的继续按钮或直接输入修改意见即可推进',
      elapsedSec: tr.lastStepAtMs ? Math.max(0, Math.round((now - tr.lastStepAtMs) / 1000)) : 0,
      startedAtMs: tr.lastStepAtMs || now,
      turnStartedAtMs: turnStart,
      modelName,
      invocationNum,
      process: null,
      alertKey: null,
    };
  }

  if (activeSubagents.length > 0 || runningBgTasks.length > 0) {
    const lead = activeSubagents[0];
    return {
      state: 'SUBAGENT_RUNNING',
      badge: activeSubagents.length > 0 ? `${activeSubagents.length} 个子代理运行中` : '后台任务运行中',
      severity: 'healthy',
      headline: lead ? `【${lead.role}】${lead.headline}` : runningBgTasks[0].description,
      detail: lead ? `${lead.badge} · 已执行 ${lead.stepCount} 步` : '正在等待后台任务回调通知',
      elapsedSec: lead ? lead.elapsedSec : 0,
      startedAtMs: lead?.startedAtMs || now,
      turnStartedAtMs: turnStart,
      modelName,
      invocationNum,
      process: null,
      alertKey: null,
    };
  }

  if (tr.latestErrorStep) {
    return {
      state: 'ERROR_STOPPED',
      badge: QUOTA_RE.test(tr.latestErrorStep.error) ? '配额受限' : '执行报错',
      severity: 'danger',
      headline: '最后一步返回异常错误',
      detail: tr.latestErrorStep.error,
      elapsedSec: 0,
      startedAtMs: tr.latestErrorStep.atMs || now,
      turnStartedAtMs: turnStart,
      modelName,
      invocationNum,
      process: null,
      alertKey: null,
    };
  }

  if (tr.stepCount > 0) {
    const lastToolRound = [...tr.rounds]
      .reverse()
      .find((r) => r.kind === 'planner' && r.tools?.length > 0);
    const approxDur = (turnStart && tr.lastStepAtMs && tr.lastStepAtMs >= turnStart)
      ? Math.round((tr.lastStepAtMs - turnStart) / 1000)
      : 0;
    return {
      state: 'COMPLETED',
      badge: '已完成',
      severity: 'idle',
      headline: lastToolRound?.tools?.[0]?.label ? `最近操作：${lastToolRound.tools[0].label}` : '本轮执行已正常结束',
      detail: '',
      elapsedSec: 0,
      startedAtMs: tr.lastStepAtMs,
      turnStartedAtMs: turnStart,
      turnDurationSec: approxDur,
      modelName,
      invocationNum,
      process: null,
      alertKey: null,
    };
  }

  return {
    state: 'IDLE',
    badge: '空闲待命',
    severity: 'idle',
    headline: '等待发送任务指令',
    detail: '发送长任务后将自动实时追踪心跳、阶段进度与子代理状态',
    elapsedSec: 0,
    startedAtMs: null,
    turnStartedAtMs: null,
    modelName,
    invocationNum: 0,
    process: null,
    alertKey: null,
  };
}

export function formatDurationShort(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}
