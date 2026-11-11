/**
 * Antigravity 会话监控侧边栏后端服务（`sidecars/session_monitor/main.mjs`）。
 *
 * 基于官方 `sidecar_sdk`（`SidecarApp`, `Response`）承载右侧监控面板，
 * 聚合生命周期钩子快照、`transcript.jsonl` 对话日志、`task.md` 阶段进度、Token 生成速度与本机子进程占用率。
 */
import { execFile, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import {
  buildCompactHint,
  DEFAULT_SETTINGS,
  evaluateConversationHealth,
  formatDurationShort,
  matchActiveProcess,
  normalizeSettings,
  oneLine,
  parseIsoMs,
  parseMilestoneMarkdown,
  parsePsOutput,
  parseTranscript,
} from './state_engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-fA-F-]{8,64}$/;
const BOOTED_AT = Date.now();
const GLOBAL_LOOKBACK_MS = 8 * 60 * 60 * 1000; // Scan sessions active in last 8h
const PS_TTL_MS = 2000;
const GLOBAL_SCAN_TTL_MS = 2500;

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

// ---------------------------------------------------------------------------
// App Data & Persistent Sidecar Data Directories
// ---------------------------------------------------------------------------

function resolveSidecarDataDir() {
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  }
  return join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'antigravity-session-monitor', 'session_monitor', 'data');
}

function findAppDataDirs() {
  const execData = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execData) {
    for (let d = execData; d && d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const appData = dirname(d);
        return existsSync(join(appData, 'brain')) ? [appData] : [appData];
      }
    }
  }
  if (process.env.ANTIGRAVITY_APP_DATA_DIR) {
    return [process.env.ANTIGRAVITY_APP_DATA_DIR];
  }
  const root = join(homedir(), '.gemini');
  const candidates = safeReaddir(root)
    .sort()
    .map((name) => join(root, name))
    .filter((p) => existsSync(join(p, 'brain')));
  return candidates.length ? candidates : [join(root, 'antigravity')];
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function statOf(filePath) {
  try {
    const s = statSync(filePath);
    return { mtime: s.mtimeMs, size: s.size, isFile: s.isFile() };
  } catch {
    return { mtime: 0, size: -1, isFile: false };
  }
}

// ---------------------------------------------------------------------------
// File Cache (keyed on path -> mtime:size)
// ---------------------------------------------------------------------------

const fileCache = new Map();
function readCached(filePath, maxBytes = 8 * 1024 * 1024) {
  const st = statOf(filePath);
  if (st.size < 0 || !st.isFile) return { text: null, key: '-', ...st };
  if (st.size > maxBytes) return { text: null, key: `large:${st.mtime}:${st.size}`, tooLarge: true, ...st };
  const key = `${st.mtime}:${st.size}`;
  const hit = fileCache.get(filePath);
  if (hit && hit.key === key) return { text: hit.text, key, ...st };
  try {
    const text = readFileSync(filePath, 'utf-8');
    if (fileCache.size > 400) fileCache.clear();
    fileCache.set(filePath, { key, text });
    return { text, key, ...st };
  } catch {
    return { text: null, key: '-', ...st };
  }
}

// ---------------------------------------------------------------------------
// Host SQLite Ground-Truth Readers (`conversation_summaries.db` & `conversations/<id>.db`)
// Uses built-in `node:sqlite` (Node 22.5+/Electron 24) with stat-based caching and immediate close.
// ---------------------------------------------------------------------------

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

function sqliteFileSig(dbPath) {
  const dbSt = statOf(dbPath);
  if (!dbSt.isFile || dbSt.size <= 0) return '';
  const walSt = statOf(`${dbPath}-wal`);
  return `${Math.round(dbSt.mtime)}:${dbSt.size}|${Math.round(walSt.mtime)}:${walSt.size}`;
}

const summaryDbCache = new Map(); // appData -> { sig, byId: Map }

function getSummaryRow(appData, convId) {
  if (!DatabaseSync || !appData || !convId) return null;
  const dbPath = join(appData, 'conversation_summaries.db');
  const sig = sqliteFileSig(dbPath);
  if (!sig) return null;

  const cached = summaryDbCache.get(appData);
  if (cached && cached.sig === sig) {
    return cached.byId.get(convId) || null;
  }

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 150 });
    const rows = db.prepare(
      `SELECT conversation_id, title, step_count, status, not_fully_idle, killed,
              last_user_input_step_index, last_modified_time
       FROM conversation_summaries
       ORDER BY last_modified_time DESC
       LIMIT 400`,
    ).all();
    const byId = new Map();
    for (const r of rows) {
      if (!r?.conversation_id) continue;
      const rawTitle = typeof r.title === 'string' ? r.title.replace(/^\/[a-zA-Z0-9_-]+\s+/, '').trim() : '';
      byId.set(r.conversation_id, {
        title: rawTitle ? oneLine(rawTitle, 90) : '',
        stepCount: Number.isFinite(r.step_count) ? Number(r.step_count) : null,
        cascadeStatus: typeof r.status === 'string' ? r.status : '',
        notFullyIdle: Boolean(r.not_fully_idle),
        killed: Boolean(r.killed),
        lastUserInputStepIndex: Number.isFinite(r.last_user_input_step_index) ? Number(r.last_user_input_step_index) : -1,
        lastModifiedMs: parseIsoMs(typeof r.last_modified_time === 'string' ? r.last_modified_time : ''),
      });
    }
    if (summaryDbCache.size > 8) summaryDbCache.clear();
    summaryDbCache.set(appData, { sig, byId });
    return byId.get(convId) || null;
  } catch {
    return cached?.byId?.get(convId) || null;
  } finally {
    try { db?.close(); } catch {}
  }
}

const convDbCache = new Map(); // dbPath -> { sig, info }

function readConvDbStepsInfo(appData, convId) {
  if (!DatabaseSync || !appData || !convId) return null;
  const dbPath = join(appData, 'conversations', `${convId}.db`);
  const sig = sqliteFileSig(dbPath);
  if (!sig) return null;

  const cached = convDbCache.get(dbPath);
  if (cached && cached.sig === sig) return cached.info;

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 150 });
    const tailRows = db.prepare(
      'SELECT idx, step_type AS stepType, status FROM steps ORDER BY idx DESC LIMIT 12',
    ).all();
    const liveStepCount = tailRows.length > 0 && Number.isFinite(tailRows[0].idx)
      ? Number(tailRows[0].idx) + 1
      : 0;

    const stepStatusByIndex = {};
    const batchAfterPlanner = [];
    let hitPlanner = false;
    for (const r of tailRows) {
      const idx = Number(r.idx);
      const status = Number(r.status);
      const stepType = Number(r.stepType);
      if (Number.isFinite(idx)) {
        stepStatusByIndex[idx] = { status, stepType };
      }
      if (!hitPlanner) {
        if (stepType === 15) {
          hitPlanner = true;
        } else {
          batchAfterPlanner.push({ idx, stepType, status });
        }
      }
    }

    // CortexStepStatus: 1=PENDING, 2=RUNNING, 3=DONE, 4=INVALID, 5=CLEARED,
    // 6=CANCELED, 7=ERROR, 8=GENERATING, 9=WAITING, 11=QUEUED, 12=INTERRUPTED
    const hasWaitingStep = batchAfterPlanner.some((s) => s.status === 9);
    const hasRunningStep = tailRows[0]?.status === 8
      || batchAfterPlanner.some((s) => s.status === 1 || s.status === 2 || s.status === 8 || s.status === 11);
    const hasCanceledTailStep = batchAfterPlanner.length > 0
      && batchAfterPlanner.every((s) => [3, 4, 5, 6, 7, 12].includes(s.status))
      && batchAfterPlanner.some((s) => s.status === 5 || s.status === 6 || s.status === 12);

    const info = {
      sig,
      liveStepCount,
      tailStepIdx: tailRows.length > 0 ? Number(tailRows[0].idx) : -1,
      tailStepStatus: tailRows.length > 0 ? Number(tailRows[0].status) : null,
      hasWaitingStep,
      hasRunningStep,
      hasCanceledTailStep,
      stepStatusByIndex,
    };
    if (convDbCache.size > 200) convDbCache.clear();
    convDbCache.set(dbPath, { sig, info });
    return info;
  } catch {
    return cached?.info || null;
  } finally {
    try { db?.close(); } catch {}
  }
}

function readRuntimeMeta(appData, convId) {
  const summary = getSummaryRow(appData, convId);
  const convDb = readConvDbStepsInfo(appData, convId);
  if (!summary && !convDb) return null;

  const liveStepCount = convDb
    ? convDb.liveStepCount
    : (summary?.cascadeStatus === 'CASCADE_RUN_STATUS_IDLE' ? summary.stepCount : null);

  const key = [
    liveStepCount ?? '-',
    convDb?.tailStepStatus ?? '-',
    convDb?.hasWaitingStep ? 1 : 0,
    convDb?.hasRunningStep ? 1 : 0,
    convDb?.hasCanceledTailStep ? 1 : 0,
    summary?.cascadeStatus || '-',
    summary?.notFullyIdle ? 1 : 0,
    summary?.lastModifiedMs || 0,
  ].join(':');

  return {
    key,
    title: summary?.title || '',
    liveStepCount,
    cascadeStatus: summary?.cascadeStatus || '',
    notFullyIdle: Boolean(summary?.notFullyIdle),
    killed: Boolean(summary?.killed),
    lastModifiedMs: summary?.lastModifiedMs || null,
    lastUserInputStepIndex: summary?.lastUserInputStepIndex ?? -1,
    tailStepStatus: convDb?.tailStepStatus ?? null,
    hasWaitingStep: Boolean(convDb?.hasWaitingStep),
    hasRunningStep: Boolean(convDb?.hasRunningStep),
    hasCanceledTailStep: Boolean(convDb?.hasCanceledTailStep),
    stepStatusByIndex: convDb?.stepStatusByIndex || null,
  };
}

const parsedTranscriptCache = new Map();
function getParsedTranscript(appData, convId, hookData = null, runtimeMeta = null) {
  const p = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  const f = readCached(p, 16 * 1024 * 1024);
  if (f.text == null) return { key: '-', parsed: parseTranscript('', 0, hookData, runtimeMeta), mtime: 0 };
  const hookSig = `${hookData?.stop?.stoppedAt || 0}:${hookData?.recentHookEvents?.length || 0}`;
  const rtSig = runtimeMeta?.key || '-';
  const fullKey = `${f.key}|${hookSig}|${rtSig}`;
  const hit = parsedTranscriptCache.get(p);
  if (hit && hit.key === fullKey) return hit;
  const parsed = parseTranscript(f.text, f.mtime, hookData, runtimeMeta);
  const entry = { key: fullKey, parsed, mtime: f.mtime };
  if (parsedTranscriptCache.size > 200) parsedTranscriptCache.clear();
  parsedTranscriptCache.set(p, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Settings Persistence
// ---------------------------------------------------------------------------

const sidecarDataDir = resolveSidecarDataDir();
const settingsPath = join(sidecarDataDir, 'settings.json');

function loadSettings() {
  try {
    if (existsSync(settingsPath)) {
      return normalizeSettings(JSON.parse(readFileSync(settingsPath, 'utf-8')));
    }
  } catch {
    // Fall back to defaults
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(patch) {
  const current = loadSettings();
  const merged = normalizeSettings({ ...current, ...(patch || {}) });
  try {
    mkdirSync(sidecarDataDir, { recursive: true });
    const tmp = `${settingsPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
    renameSync(tmp, settingsPath);
  } catch (err) {
    console.error('[session-monitor] failed saving settings:', err.message);
  }
  return merged;
}

let userSettings = loadSettings();

// ---------------------------------------------------------------------------
// Conversation Titles via `agentapi` (Async Cached)
// ---------------------------------------------------------------------------

const titleCache = new Map(); // convId -> string | Promise
function resolveConversationTitle(convId, fallback = '') {
  if (!convId || !ID_RE.test(convId)) return fallback;
  const hit = titleCache.get(convId);
  if (typeof hit === 'string') return hit || fallback;
  if (!hit) {
    const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
    const file = exe || 'agentapi';
    const args = [...(exe ? ['agentapi'] : []), 'get-conversation-metadata', convId];
    const p = new Promise((resolve) => {
      execFile(file, args, { encoding: 'utf-8', timeout: 4000 }, (err, stdout) => {
        if (err) return resolve('');
        try {
          const data = JSON.parse(stdout || '{}');
          const meta = data?.response?.conversationMetadata?.metadata
            || data?.response?.conversation_metadata?.metadata
            || data?.metadata
            || data;
          const t = String(meta?.title || meta?.summary || data?.title || '').replace(/^\/[a-zA-Z0-9_-]+\s+/, '');
          resolve(t ? oneLine(t, 90) : '');
        } catch {
          resolve('');
        }
      });
    }).then((title) => {
      titleCache.set(convId, title);
      return title;
    });
    titleCache.set(convId, p);
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Non-blocking macOS Process Table Sampler (`ps`)
// ---------------------------------------------------------------------------

let psCache = { at: 0, rows: [], inflight: null };

function refreshPsRows() {
  const now = Date.now();
  if (now - psCache.at < PS_TTL_MS) return Promise.resolve(psCache.rows);
  if (psCache.inflight) return psCache.inflight;

  psCache.inflight = new Promise((resolve) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,%cpu=,etime=,command='],
      { encoding: 'utf-8', timeout: 1500, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        psCache.inflight = null;
        if (!err && stdout) {
          psCache.rows = parsePsOutput(stdout);
          psCache.at = Date.now();
        }
        resolve(psCache.rows);
      },
    );
  });
  return psCache.inflight;
}

// ---------------------------------------------------------------------------
// Safe Brain File URI Resolution & Milestone Extraction
// ---------------------------------------------------------------------------

function safeBrainFileUri(appData, candidatePath) {
  try {
    const brainRoot = realpathSync(join(appData, 'brain'));
    const resolved = realpathSync(candidatePath);
    if (!resolved.startsWith(brainRoot + sep)) return '';
    if (!statSync(resolved).isFile()) return '';
    return pathToFileURL(resolved).href;
  } catch {
    return '';
  }
}

function readConversationMilestones(appData, convId) {
  const convBrainDir = join(appData, 'brain', convId);
  const taskMdPath = join(convBrainDir, 'task.md');
  const taskFile = readCached(taskMdPath, 128 * 1024);
  if (taskFile.text) {
    const parsed = parseMilestoneMarkdown(taskFile.text, 'task.md', taskMdPath);
    if (parsed) {
      parsed.fileUri = safeBrainFileUri(appData, taskMdPath);
      return { key: `task.md:${taskFile.key}`, milestones: parsed };
    }
  }

  // Fallback: check other .md files in conversation artifact root (newest first)
  const mdFiles = safeReaddir(convBrainDir)
    .filter((f) => f.endsWith('.md') && f !== 'task.md')
    .map((f) => {
      const full = join(convBrainDir, f);
      return { name: f, full, mtime: statOf(full).mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const mf of mdFiles.slice(0, 5)) {
    const fc = readCached(mf.full, 128 * 1024);
    if (!fc.text) continue;
    const parsed = parseMilestoneMarkdown(fc.text, mf.name, mf.full);
    if (parsed) {
      parsed.fileUri = safeBrainFileUri(appData, mf.full);
      return { key: `${mf.name}:${fc.key}`, milestones: parsed };
    }
  }

  return { key: '-', milestones: null };
}

function readHookSession(appData, convId) {
  const p = join(appData, 'plugin_data', 'antigravity-session-monitor', 'sessions', `${convId}.json`);
  const f = readCached(p, 256 * 1024);
  if (!f.text) return { key: '-', data: null };
  try {
    return { key: f.key, data: JSON.parse(f.text) };
  } catch {
    return { key: '-', data: null };
  }
}

// Read native swarm members if this conversation coordinates a swarm
function readSwarmSubagentRefs(appData, convId) {
  const membersPath = join(appData, 'brain', convId, '.system_generated', 'swarm', 'members.json');
  const f = readCached(membersPath, 256 * 1024);
  if (!f.text) return [];
  try {
    const obj = JSON.parse(f.text);
    const roleMap = { narrator: '叙述员', monitor: '巡检员', coordinator: '协调员' };
    const out = [];
    for (const [name, m] of Object.entries(obj?.members || {})) {
      if (!m?.conversation_id || m.conversation_id === convId || m.killed) continue;
      const zhRole = m.role && m.role !== 'worker' ? (roleMap[m.role] || m.role) : '';
      out.push({
        conversationId: m.conversation_id,
        role: `${name}${zhRole ? `（${zhRole}）` : ''}`,
        typeName: 'swarm',
        model: m.model || '',
        startedAtMs: null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function locateConversationAppData(convId) {
  const dirs = findAppDataDirs();
  for (const d of dirs) {
    if (
      existsSync(join(d, 'brain', convId))
      || existsSync(join(d, 'plugin_data', 'antigravity-session-monitor', 'sessions', `${convId}.json`))
    ) {
      return d;
    }
  }
  return dirs[0];
}

// ---------------------------------------------------------------------------
// Full & Lightweight Session Builders
// ---------------------------------------------------------------------------

function summarizeSubagent(appData, ref, psRows, now) {
  const subId = ref.conversationId;
  const hook = readHookSession(appData, subId);
  const runtimeMeta = readRuntimeMeta(appData, subId);
  const trEntry = getParsedTranscript(appData, subId, hook.data, runtimeMeta);
  const tr = trEntry.parsed;

  let proc = null;
  if (tr.pendingTools[0]?.name === 'run_command') {
    proc = matchActiveProcess(psRows, {
      commandLine: tr.pendingTools[0].commandLine,
      workspacePaths: hook.data?.workspacePaths || [],
      ownPid: process.pid,
    });
  }

  const health = evaluateConversationHealth({
    now,
    hookState: hook.data,
    transcript: tr,
    subagents: [],
    proc,
    runtimeMeta,
    settings: userSettings,
  });

  const isRunning = ['THINKING', 'THINKING_DEEP', 'TOOL_ACTIVE', 'RETRYING', 'SUBAGENT_RUNNING'].includes(health.state);

  return {
    conversationId: subId,
    role: ref.role || '子代理',
    typeName: ref.typeName || 'subagent',
    model: ref.model || health.modelName || '',
    state: health.state,
    severity: health.severity,
    badge: health.badge,
    headline: health.headline,
    detail: health.detail,
    elapsedSec: health.elapsedSec || 0,
    startedAtMs: health.startedAtMs || ref.startedAtMs || null,
    stepCount: tr.stepCount,
    tokens: tr.tokens,
    tokenSpeed: tr.tokenSpeed,
    isRunning,
    key: `${hook.key}|${trEntry.key}|${health.state}|${tr.tokenSpeed.latestTps ?? '-'}`,
  };
}

function buildConversationSnapshot(convId, psRows, now) {
  if (!convId || !ID_RE.test(convId)) {
    return {
      conversationId: '',
      found: false,
      etagPart: 'empty',
      health: evaluateConversationHealth({ now, settings: userSettings }),
      milestones: null,
      subagents: [],
      bgTasks: [],
      rounds: [],
      tokens: { input: 0, cache: 0, output: 0, currentContext: 0 },
      tokenSpeed: { latestTps: null, avgTps: null, peakTps: null, measuredRounds: 0 },
    };
  }

  const appData = locateConversationAppData(convId);
  const hook = readHookSession(appData, convId);
  const runtimeMeta = readRuntimeMeta(appData, convId);
  const trEntry = getParsedTranscript(appData, convId, hook.data, runtimeMeta);
  const tr = trEntry.parsed;
  const msEntry = readConversationMilestones(appData, convId);

  // Merge subagents from invoke_subagent + native swarm
  const subRefsMap = new Map();
  for (const r of tr.subagentRefs) subRefsMap.set(r.conversationId, r);
  for (const r of readSwarmSubagentRefs(appData, convId)) {
    if (!subRefsMap.has(r.conversationId)) subRefsMap.set(r.conversationId, r);
  }

  const subagents = [...subRefsMap.values()].map((ref) => summarizeSubagent(appData, ref, psRows, now));
  // Active / attention subagents first, then newest
  subagents.sort((a, b) => {
    const rank = (s) => (s.severity === 'danger' || s.severity === 'warning' ? 0 : (s.isRunning ? 1 : 2));
    return rank(a) - rank(b);
  });

  let proc = null;
  if (tr.pendingTools[0]?.name === 'run_command') {
    proc = matchActiveProcess(psRows, {
      commandLine: tr.pendingTools[0].commandLine,
      workspacePaths: hook.data?.workspacePaths || [],
      ownPid: process.pid,
    });
  }

  const health = evaluateConversationHealth({
    now,
    hookState: hook.data,
    transcript: tr,
    subagents,
    proc,
    runtimeMeta,
    settings: userSettings,
  });

  const rawFallbackTitle = runtimeMeta?.title || tr.titleCandidate || hook.data?.firstUserInput || hook.data?.lastUserInput || '';
  const fallbackTitle = String(rawFallbackTitle).replace(/^\/[a-zA-Z0-9_-]+\s+/, '');
  const title = runtimeMeta?.title || resolveConversationTitle(convId, fallbackTitle);
  const workspaceName = Array.isArray(hook.data?.workspacePaths) && hook.data.workspacePaths[0]
    ? basename(hook.data.workspacePaths[0])
    : '';

  // Aggregate total tokens including subagents
  const subTokens = subagents.reduce(
    (acc, s) => ({
      input: acc.input + (s.tokens?.input || 0),
      cache: acc.cache + (s.tokens?.cache || 0),
      output: acc.output + (s.tokens?.output || 0),
    }),
    { input: 0, cache: 0, output: 0 },
  );

  const isEndedState = ['IDLE', 'COMPLETED', 'ERROR_STOPPED'].includes(health.state);
  const totalTurnSec = health.turnDurationSec != null
    ? health.turnDurationSec
    : (!isEndedState && health.turnStartedAtMs ? Math.max(0, Math.round((now - health.turnStartedAtMs) / 1000)) : 0);

  const activeSubagentTpsSum = Math.round(
    subagents
      .filter((s) => s.isRunning && s.tokenSpeed?.latestTps)
      .reduce((acc, s) => acc + s.tokenSpeed.latestTps, 0) * 10,
  ) / 10;

  const compactHint = buildCompactHint(
    {
      stepCount: tr.stepCount,
      stepsSinceCompact: tr.stepsSinceCompact,
      currentContext: tr.tokens.currentContext,
      compactCount: tr.compactCount,
    },
    userSettings,
  );

  const isCompacting = Boolean(
    tr.isCompactPending && ['THINKING', 'THINKING_DEEP', 'RETRYING'].includes(health.state),
  );
  const revertedStepsTotal = (tr.rolledBackSteps || 0) + (tr.revertedTailSteps || 0);

  const cpuBucket = proc ? Math.round(proc.cpu) : -1;
  const etagPart = [
    convId,
    hook.key,
    trEntry.key,
    msEntry.key,
    health.state,
    health.badge,
    cpuBucket,
    tr.tokenSpeed.latestTps ?? '-',
    activeSubagentTpsSum,
    compactHint?.level ?? '-',
    isCompacting ? 1 : 0,
    revertedStepsTotal,
    title,
    subagents.map((s) => s.key).join(','),
  ].join('|');

  // Return newest 40 rounds in reverse chronological order for the Timeline tab
  const timelineRounds = tr.rounds.slice(-40).reverse();

  return {
    conversationId: convId,
    found: Boolean(hook.data || tr.stepCount > 0 || runtimeMeta || msEntry.milestones),
    title: title || '当前会话',
    workspaceName,
    etagPart,
    health: {
      ...health,
      totalTurnSec,
      totalTurnFormatted: formatDurationShort(totalTurnSec),
    },
    milestones: msEntry.milestones,
    subagents,
    bgTasks: tr.bgTasks.filter((b) => b.status === 'running'),
    rounds: timelineRounds,
    totalRounds: tr.rounds.filter((r) => r.kind === 'planner').length,
    stepCount: tr.stepCount,
    stepsSinceCompact: tr.stepsSinceCompact,
    compactCount: tr.compactCount,
    isCompacting,
    revertedStepsTotal,
    compactHint,
    avgThinkingSec: tr.avgThinkingMs ? Math.max(1, Math.round(tr.avgThinkingMs / 1000)) : null,
    tokenSpeed: {
      ...tr.tokenSpeed,
      activeSubagentTpsSum: activeSubagentTpsSum || null,
    },
    tokens: {
      ...tr.tokens,
      subagentInput: subTokens.input,
      subagentOutput: subTokens.output,
      grandTotalOutput: tr.tokens.output + subTokens.output,
    },
  };
}

// ---------------------------------------------------------------------------
// Global Parallel Sessions Scanner (Cached 2.5s)
// ---------------------------------------------------------------------------

let globalCache = { at: 0, items: [], key: '' };

function getGlobalSessions(psRows, now) {
  if (now - globalCache.at < GLOBAL_SCAN_TTL_MS) return globalCache;

  const candidateIds = new Map(); // convId -> { appData, mtime }
  for (const appData of findAppDataDirs()) {
    const sessDir = join(appData, 'plugin_data', 'antigravity-session-monitor', 'sessions');
    for (const f of safeReaddir(sessDir)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      const mtime = statOf(join(sessDir, f)).mtime;
      if (now - mtime <= GLOBAL_LOOKBACK_MS) {
        candidateIds.set(id, { appData, mtime });
      }
    }
    const brainDir = join(appData, 'brain');
    for (const id of safeReaddir(brainDir)) {
      if (!ID_RE.test(id)) continue;
      const tp = join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
      const mtime = statOf(tp).mtime;
      if (mtime > 0 && now - mtime <= GLOBAL_LOOKBACK_MS) {
        const prev = candidateIds.get(id);
        if (!prev || mtime > prev.mtime) candidateIds.set(id, { appData, mtime });
      }
    }
  }

  // Sort newest first and inspect top 16 recent sessions
  const sorted = [...candidateIds.entries()]
    .sort((a, b) => b[1].mtime - a[1].mtime)
    .slice(0, 16);

  // Track child subagent IDs so we don't duplicate subagents as top-level conversations
  const childSubagentIds = new Set();
  const rawSummaries = [];

  for (const [id, { appData, mtime }] of sorted) {
    const hook = readHookSession(appData, id);
    const runtimeMeta = readRuntimeMeta(appData, id);
    const trEntry = getParsedTranscript(appData, id, hook.data, runtimeMeta);
    for (const sr of trEntry.parsed.subagentRefs) {
      childSubagentIds.add(sr.conversationId);
    }
    for (const sr of readSwarmSubagentRefs(appData, id)) {
      childSubagentIds.add(sr.conversationId);
    }
    rawSummaries.push({ id, appData, mtime, hook, runtimeMeta, tr: trEntry.parsed });
  }

  const items = [];
  for (const { id, appData, mtime, hook, runtimeMeta, tr } of rawSummaries) {
    if (childSubagentIds.has(id)) continue;
    let proc = null;
    if (tr.pendingTools[0]?.name === 'run_command') {
      proc = matchActiveProcess(psRows, {
        commandLine: tr.pendingTools[0].commandLine,
        workspacePaths: hook.data?.workspacePaths || [],
        ownPid: process.pid,
      });
    }
    const health = evaluateConversationHealth({
      now,
      hookState: hook.data,
      transcript: tr,
      subagents: [],
      proc,
      runtimeMeta,
      settings: userSettings,
    });
    const msEntry = readConversationMilestones(appData, id);
    const rawFallbackTitle = runtimeMeta?.title || tr.titleCandidate || hook.data?.firstUserInput || hook.data?.lastUserInput || id.slice(0, 8);
    const fallbackTitle = String(rawFallbackTitle).replace(/^\/[a-zA-Z0-9_-]+\s+/, '');
    const title = runtimeMeta?.title || resolveConversationTitle(id, fallbackTitle);
    const workspaceName = Array.isArray(hook.data?.workspacePaths) && hook.data.workspacePaths[0]
      ? basename(hook.data.workspacePaths[0])
      : '';

    const isActive = !['IDLE', 'COMPLETED'].includes(health.state);
    items.push({
      conversationId: id,
      title: title || `会话 ${id.slice(0, 8)}`,
      workspaceName,
      state: health.state,
      severity: health.severity,
      badge: health.badge,
      headline: health.headline,
      elapsedSec: health.elapsedSec || 0,
      startedAtMs: health.startedAtMs || null,
      isActive,
      milestonePercent: msEntry.milestones ? msEntry.milestones.percent : null,
      milestoneLabel: msEntry.milestones ? `${msEntry.milestones.done}/${msEntry.milestones.total}` : '',
      stepCount: tr.stepCount,
      stepsSinceCompact: tr.stepsSinceCompact,
      compactCount: tr.compactCount,
      compactHint: buildCompactHint(
        {
          stepCount: tr.stepCount,
          stepsSinceCompact: tr.stepsSinceCompact,
          currentContext: tr.tokens.currentContext,
          compactCount: tr.compactCount,
        },
        userSettings,
      ),
      tokenSpeed: tr.tokenSpeed,
      outTokens: tr.tokens.output,
      updatedAtMs: Math.max(mtime, hook.data?.updatedAt || 0, runtimeMeta?.lastModifiedMs || 0),
    });
  }

  // Sort: attention/warning first, then active running, then recently completed
  items.sort((a, b) => {
    const prio = (x) => {
      if (x.severity === 'danger' || x.severity === 'warning' || x.severity === 'action_required') return 0;
      if (x.isActive) return 1;
      return 2;
    };
    return (prio(a) - prio(b)) || (b.updatedAtMs - a.updatedAtMs);
  });

  const key = items.map(
    (i) => `${i.conversationId}:${i.state}:${i.badge}:${i.milestoneLabel}:${i.tokenSpeed?.latestTps ?? '-'}:${i.compactHint?.level ?? '-'}`,
  ).join(';');
  globalCache = { at: now, items: items.slice(0, 12), key };
  return globalCache;
}

// ---------------------------------------------------------------------------
// UI 版本检测、系统剪贴板兜底与后端文件热重载监听
// ---------------------------------------------------------------------------

function computeUiBuildKey() {
  return ['index.html', 'styles.css', 'app.js']
    .map((f) => {
      const st = statOf(join(__dirname, f));
      return `${Math.round(st.mtime)}:${st.size}`;
    })
    .join('|');
}

function copyToSystemClipboard(text) {
  const payload = String(text ?? '').slice(0, 128 * 1024);
  if (process.platform !== 'darwin') {
    return Promise.resolve({ ok: false, reason: '当前系统不支持原生剪贴板写入' });
  }
  return new Promise((resolve) => {
    try {
      const child = spawn('/usr/bin/pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        resolve({ ok });
      };
      child.on('error', () => done(false));
      child.on('close', (code) => done(code === 0));
      child.stdin.on('error', () => done(false));
      child.stdin.end(payload, 'utf-8');
    } catch {
      resolve({ ok: false });
    }
  });
}

const BACKEND_FILES = [join(__dirname, 'main.mjs'), join(__dirname, 'state_engine.mjs')];
const INITIAL_BACKEND_SIG = BACKEND_FILES.map((p) => {
  const st = statOf(p);
  return `${Math.round(st.mtime)}:${st.size}`;
}).join('|');

const reloadWatchTimer = setInterval(() => {
  const sig = BACKEND_FILES.map((p) => {
    const st = statOf(p);
    return `${Math.round(st.mtime)}:${st.size}`;
  }).join('|');
  if (sig !== INITIAL_BACKEND_SIG) {
    console.log('[session-monitor] 检测到后端模块文件更新，主动退出以触发宿主热重载');
    process.exit(0);
  }
}, 3000);
reloadWatchTimer.unref?.();

// ---------------------------------------------------------------------------
// SidecarApp Server Wiring
// ---------------------------------------------------------------------------

const app = new SidecarApp();

app.page('/', () => {
  const { text } = readCached(join(__dirname, 'index.html'));
  return new Response(text || '<h1>会话监控面板页面文件缺失</h1>', {
    contentType: 'text/html; charset=utf-8',
    headers: { 'Cache-Control': 'no-cache' },
  });
});

for (const [route, [filename, mime]] of Object.entries(STATIC_ASSETS)) {
  app.page(route, () => {
    const { text } = readCached(join(__dirname, filename));
    if (text == null) {
      return new Response('未找到资源文件', { status: 404, contentType: 'text/plain; charset=utf-8' });
    }
    return new Response(text, {
      contentType: mime,
      headers: { 'Cache-Control': 'no-cache' },
    });
  });
}

const handleStateRequest = async (data) => {
  const now = Date.now();
  const rawConv = typeof data?.conversationId === 'string' && data.conversationId
    ? data.conversationId
    : (app.config.conversationId || '');
  const convId = ID_RE.test(rawConv) ? rawConv : '';

  const psRows = await refreshPsRows();
  const current = buildConversationSnapshot(convId, psRows, now);
  const global = getGlobalSessions(psRows, now);
  const activeCount = global.items.filter((it) => it.isActive).length;
  const attentionCount = global.items.filter(
    (it) => it.severity === 'warning' || it.severity === 'danger' || it.severity === 'action_required',
  ).length;

  const uiBuildKey = computeUiBuildKey();
  const settingsKey = JSON.stringify(userSettings);
  const fullEtag = `${current.etagPart}||${global.key}||${settingsKey}||${uiBuildKey}`;

  if (data?.etag && data.etag === fullEtag) {
    return {
      unchanged: true,
      etag: fullEtag,
      uiBuildKey,
      serverNow: now,
      conversationId: convId,
    };
  }

  return {
    unchanged: false,
    etag: fullEtag,
    uiBuildKey,
    serverNow: now,
    conversationId: convId,
    settings: userSettings,
    current,
    global: {
      activeCount,
      attentionCount,
      sessions: global.items,
    },
  };
};

app.api('/api/state', handleStateRequest, 'GET');

app.api('/api/settings', (data) => {
  userSettings = saveSettings(data);
  globalCache.at = 0;
  return { ok: true, settings: userSettings };
}, 'POST');

let compactInFlight = false;

function triggerDirectCompact(data) {
  if (compactInFlight) {
    return Promise.resolve({ ok: false, reason: '正在触发压缩中，请勿重复点击' });
  }
  if (process.platform !== 'darwin') {
    return Promise.resolve({ ok: false, reason: '当前系统暂不支持界面直连压缩' });
  }

  const pyBin = existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
  const scriptPath = join(__dirname, 'macos_compact.py');
  const payload = JSON.stringify({
    title: String(data?.title || '').slice(0, 120),
    workspaceName: String(data?.workspaceName || '').slice(0, 80),
  });
  compactInFlight = true;

  return new Promise((resolve) => {
    try {
      const child = spawn(pyBin, ['-B', scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      let out = '';
      let errOut = '';
      let settled = false;

      const finish = (res) => {
        if (settled) return;
        settled = true;
        compactInFlight = false;
        resolve(res);
      };

      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        finish({ ok: false, reason: '触发压缩超时，请重试' });
      }, 6500);

      child.stdout.on('data', (chunk) => { out += chunk.toString('utf-8'); });
      child.stderr.on('data', (chunk) => { errOut += chunk.toString('utf-8'); });
      child.on('error', (err) => {
        clearTimeout(timer);
        finish({ ok: false, reason: `启动压缩助手失败：${err.message}` });
      });
      child.on('close', () => {
        clearTimeout(timer);
        const trimmed = out.trim();
        if (trimmed) {
          try {
            const parsed = JSON.parse(trimmed.split('\n').pop());
            finish(parsed);
            return;
          } catch {
            // Fall through
          }
        }
        finish({ ok: false, reason: oneLine(errOut || '未能触发压缩指令', 90) });
      });

      child.stdin.on('error', () => {});
      child.stdin.end(payload, 'utf-8');
    } catch (err) {
      compactInFlight = false;
      resolve({ ok: false, reason: `触发失败：${err.message}` });
    }
  });
}

app.api('/api/clipboard', async (data) => {
  const res = await copyToSystemClipboard(data?.text ?? '');
  return res;
}, 'POST');

app.api('/api/compact', async (data) => {
  const res = await triggerDirectCompact(data || {});
  return res;
}, 'POST');

app.run().then(() => {
  console.log(`[session-monitor] 侧边栏服务已就绪 · 数据目录=${findAppDataDirs().join(',')}`);
});
