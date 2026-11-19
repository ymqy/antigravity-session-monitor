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
  unlinkSync,
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
import {
  aggregateGeneratorRows,
  aggregateGlobalUsage,
  buildNetworkSnapshot as buildNetworkSnapshotPure,
  computeCacheHitRate,
  createEmptyTrafficLedger,
  decodeGeneratorMetadataRow,
  decodeStepCreatedAtMs,
  extractProxyPortsFromEnv,
  identifyAntigravityPids,
  identifyProxyPids,
  localDateKey,
  normalizeTrafficLedger,
  parseNettopSockets,
  parseScutilProxyPorts,
  parseUserStatusQuota,
  resetTrafficLedger,
  updateTrafficLedger,
} from './metrics_engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-fA-F-]{8,64}$/;
const BOOTED_AT = Date.now();
const GLOBAL_LOOKBACK_MS = 8 * 60 * 60 * 1000; // Scan sessions active in last 8h
const PS_TTL_MS = 2000;
const NETTOP_TTL_MS = 2500;
const QUOTA_TTL_MS = 60_000;
const GLOBAL_USAGE_SCAN_TTL_MS = 5000;
const GLOBAL_SCAN_TTL_MS = 1000;

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
  const shmSt = statOf(`${dbPath}-shm`);
  return `${dbSt.mtime}:${dbSt.size}|${walSt.mtime}:${walSt.size}|${shmSt.mtime}:${shmSt.size}`;
}

function parseWorkspaceUris(raw) {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const u of arr) {
      if (typeof u !== 'string' || !u) continue;
      if (u.startsWith('file://')) {
        try {
          out.push(fileURLToPath(u));
        } catch {
          out.push(decodeURIComponent(u.slice(7)));
        }
      } else {
        out.push(u);
      }
    }
    return out;
  } catch {
    return [];
  }
}

const summaryDbCache = new Map(); // appData -> { sig, byId: Map }

function loadSummaryMap(appData) {
  if (!DatabaseSync || !appData) return null;
  const dbPath = join(appData, 'conversation_summaries.db');
  const sig = sqliteFileSig(dbPath);
  if (!sig) return null;

  const cached = summaryDbCache.get(appData);
  if (cached && cached.sig === sig) {
    return cached.byId;
  }

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 150 });
    const rows = db.prepare(
      `SELECT conversation_id, title, step_count, status, not_fully_idle, killed,
              parent_conversation_id, nesting_depth, agent_name, workspace_uris,
              last_user_input_time, last_user_input_step_index, last_modified_time
       FROM conversation_summaries
       ORDER BY last_modified_time DESC
       LIMIT 2000`,
    ).all();
    const byId = new Map();
    for (const r of rows) {
      if (!r?.conversation_id) continue;
      const rawTitle = typeof r.title === 'string' ? r.title.replace(/^\/[a-zA-Z0-9_-]+\s+/, '').trim() : '';
      const workspacePaths = parseWorkspaceUris(r.workspace_uris);
      byId.set(r.conversation_id, {
        title: rawTitle ? oneLine(rawTitle, 90) : '',
        stepCount: Number.isFinite(r.step_count) ? Number(r.step_count) : null,
        cascadeStatus: typeof r.status === 'string' ? r.status : '',
        notFullyIdle: Boolean(r.not_fully_idle),
        killed: Boolean(r.killed),
        parentConversationId: typeof r.parent_conversation_id === 'string' ? r.parent_conversation_id : '',
        nestingDepth: Number.isFinite(r.nesting_depth) ? Number(r.nesting_depth) : 0,
        agentName: typeof r.agent_name === 'string' ? r.agent_name : '',
        workspacePaths,
        lastUserInputMs: parseIsoMs(typeof r.last_user_input_time === 'string' ? r.last_user_input_time : ''),
        lastUserInputStepIndex: Number.isFinite(r.last_user_input_step_index) ? Number(r.last_user_input_step_index) : -1,
        lastModifiedMs: parseIsoMs(typeof r.last_modified_time === 'string' ? r.last_modified_time : ''),
      });
    }
    if (summaryDbCache.size > 8) summaryDbCache.clear();
    summaryDbCache.set(appData, { sig, byId });
    return byId;
  } catch {
    return cached?.byId || null;
  } finally {
    try { db?.close(); } catch {}
  }
}

function getSummaryRow(appData, convId) {
  if (!appData || !convId) return null;
  const byId = loadSummaryMap(appData);
  return byId ? (byId.get(convId) || null) : null;
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
      'SELECT idx, step_type AS stepType, status FROM steps ORDER BY idx DESC LIMIT 32',
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
    const tailStatus = tailRows.length > 0 ? Number(tailRows[0].status) : null;
    const hasWaitingStep = batchAfterPlanner.some((s) => s.status === 9);
    const hasRunningStep = tailStatus === 8
      || batchAfterPlanner.some((s) => s.status === 1 || s.status === 2 || s.status === 8 || s.status === 11);
    const hasCanceledTailStep = (tailStatus === 5 || tailStatus === 6 || tailStatus === 12)
      || (
        batchAfterPlanner.length > 0
        && batchAfterPlanner.every((s) => [3, 4, 5, 6, 7, 12].includes(s.status))
        && batchAfterPlanner.some((s) => s.status === 5 || s.status === 6 || s.status === 12)
      );

    const info = {
      sig,
      liveStepCount,
      tailStepIdx: tailRows.length > 0 ? Number(tailRows[0].idx) : -1,
      tailStepStatus: tailStatus,
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

const convUsageCache = new Map(); // dbPath -> { sig, liveKey, metrics }

function readConvUsageMetrics(appData, convId, liveStepCount = null, fallbackMs = 0) {
  if (!DatabaseSync || !appData || !convId) return null;
  const dbPath = join(appData, 'conversations', `${convId}.db`);
  const sig = sqliteFileSig(dbPath);
  if (!sig) return null;

  const liveKey = liveStepCount == null ? '-' : String(liveStepCount);
  const cached = convUsageCache.get(dbPath);
  if (cached && cached.sig === sig && cached.liveKey === liveKey) {
    return cached.metrics;
  }

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 150 });
    const stepRows = db.prepare(
      'SELECT idx, metadata FROM steps WHERE step_type IN (15, 23) AND metadata IS NOT NULL',
    ).all();
    const stepCreatedAtMap = new Map();
    for (const r of stepRows) {
      if (!r?.metadata) continue;
      const ms = decodeStepCreatedAtMs(r.metadata);
      if (ms) stepCreatedAtMap.set(Number(r.idx), ms);
    }

    const genRows = db.prepare('SELECT data FROM gen_metadata ORDER BY idx ASC').all();
    const decoded = [];
    for (const r of genRows) {
      if (!r?.data) continue;
      const d = decodeGeneratorMetadataRow(r.data);
      if (d) decoded.push(d);
    }

    const dbStat = statOf(dbPath);
    const metrics = {
      sig,
      ...aggregateGeneratorRows(decoded, stepCreatedAtMap, {
        liveStepCount,
        fallbackMs: fallbackMs || dbStat.mtime || Date.now(),
        includeStepMap: true,
      }),
    };
    if (convUsageCache.size > 120) convUsageCache.clear();
    convUsageCache.set(dbPath, { sig, liveKey, metrics });
    return metrics;
  } catch {
    return cached?.metrics || null;
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
    convDb?.sig || '-',
    convDb?.tailStepStatus ?? '-',
    convDb?.hasWaitingStep ? 1 : 0,
    convDb?.hasRunningStep ? 1 : 0,
    convDb?.hasCanceledTailStep ? 1 : 0,
    summary?.cascadeStatus || '-',
    summary?.notFullyIdle ? 1 : 0,
    summary?.killed ? 1 : 0,
    summary?.lastModifiedMs || 0,
  ].join(':');

  return {
    key,
    title: summary?.title || '',
    workspacePaths: summary?.workspacePaths || [],
    parentConversationId: summary?.parentConversationId || '',
    nestingDepth: summary?.nestingDepth || 0,
    agentName: summary?.agentName || '',
    liveStepCount,
    cascadeStatus: summary?.cascadeStatus || '',
    notFullyIdle: Boolean(summary?.notFullyIdle),
    killed: Boolean(summary?.killed),
    lastUserInputMs: summary?.lastUserInputMs || null,
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
// 持久化 OS 级网络流量监控（macOS `nettop` 套接字增量账本）
// ---------------------------------------------------------------------------

const trafficLedgerPath = join(sidecarDataDir, 'network_traffic.json');
const NETTOP_BIN = '/usr/bin/nettop';
const SCUTIL_BIN = '/usr/sbin/scutil';
const NETTOP_AVAILABLE = process.platform === 'darwin' && existsSync(NETTOP_BIN);
const SCUTIL_AVAILABLE = process.platform === 'darwin' && existsSync(SCUTIL_BIN);
const ENV_PROXY_PORTS = extractProxyPortsFromEnv(process.env);
const SCUTIL_TTL_MS = 30_000;

let scutilProxyCache = { at: 0, ports: new Set(), inflight: null };

function refreshScutilProxyPorts(now = Date.now()) {
  if (!SCUTIL_AVAILABLE) return Promise.resolve(scutilProxyCache.ports);
  if (scutilProxyCache.at > 0 && now - scutilProxyCache.at < SCUTIL_TTL_MS) {
    return Promise.resolve(scutilProxyCache.ports);
  }
  if (scutilProxyCache.inflight) return scutilProxyCache.inflight;
  scutilProxyCache.inflight = new Promise((resolve) => {
    execFile(SCUTIL_BIN, ['--proxy'], { encoding: 'utf-8', timeout: 1000 }, (err, stdout) => {
      scutilProxyCache.inflight = null;
      if (!err && stdout) {
        scutilProxyCache.ports = parseScutilProxyPorts(stdout);
      }
      scutilProxyCache.at = Date.now();
      resolve(scutilProxyCache.ports);
    });
  });
  return scutilProxyCache.inflight;
}

function loadTrafficLedger() {
  try {
    if (existsSync(trafficLedgerPath)) {
      return normalizeTrafficLedger(JSON.parse(readFileSync(trafficLedgerPath, 'utf-8')), Date.now());
    }
  } catch {
    // 损坏文件静默重建
  }
  return createEmptyTrafficLedger(Date.now());
}

function saveTrafficLedgerSync(ledger) {
  try {
    mkdirSync(sidecarDataDir, { recursive: true });
    const tmp = `${trafficLedgerPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger), 'utf-8');
    renameSync(tmp, trafficLedgerPath);
  } catch (err) {
    console.error('[session-monitor] 保存网络流量账本失败:', err.message);
  }
}

let trafficLedger = loadTrafficLedger();
let trafficLastSavedAt = 0;
let trafficDirty = false;
let trafficResetGen = 0;
let trafficCache = {
  at: 0,
  inflight: null,
  lastSample: null,
  snapshot: null,
};

function buildNetworkSnapshot(ledger, sample, now) {
  return buildNetworkSnapshotPure(ledger, sample, now, { available: NETTOP_AVAILABLE });
}

function sampleNettopOnce(psRows, timeoutMs = 2200) {
  if (!NETTOP_AVAILABLE) return Promise.resolve(null);
  return Promise.all([
    refreshScutilProxyPorts(Date.now()),
    new Promise((resolve) => {
      execFile(
        NETTOP_BIN,
        ['-L', '1', '-n', '-J', 'interface,state,bytes_in,bytes_out', '-x'],
        { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => resolve(!err && stdout ? stdout : null),
      );
    }),
  ]).then(([sysProxyPorts, stdout]) => {
    if (!stdout) return null;
    const { agyPids, procLabels } = identifyAntigravityPids(psRows, { ownPid: process.pid });
    const proxyPids = identifyProxyPids(psRows);
    const proxyPorts = new Set([...ENV_PROXY_PORTS, ...(sysProxyPorts || [])]);
    const sample = parseNettopSockets(stdout, agyPids, {
      procLabels,
      proxyPorts,
      proxyPids,
    });
    return { agyPids, sample };
  });
}

function refreshNetworkTraffic(psRows, now = Date.now()) {
  if (!NETTOP_AVAILABLE) {
    return Promise.resolve(buildNetworkSnapshot(trafficLedger, null, now));
  }
  if (
    trafficCache.snapshot
    && now - trafficCache.at < NETTOP_TTL_MS
    && trafficCache.snapshot.todayDate === localDateKey(now)
  ) {
    return Promise.resolve(trafficCache.snapshot);
  }
  if (trafficCache.inflight) return trafficCache.inflight;

  const genAtStart = trafficResetGen;
  trafficCache.inflight = sampleNettopOnce(psRows, 2200).then((res) => {
    trafficCache.inflight = null;
    const sampleNow = Date.now();
    // 若采样途中触发了用户清零重置，丢弃过期增量，防止重置前旧字节回弹
    if (genAtStart !== trafficResetGen) {
      trafficCache.snapshot = buildNetworkSnapshot(trafficLedger, trafficCache.lastSample, sampleNow);
      return trafficCache.snapshot;
    }
    if (res) {
      const { agyPids, sample } = res;
      // 仅在检测到 Antigravity 进程或存在外网/回环套接字时更新账本，防止瞬态异常误清基线
      if (agyPids.size > 0 || sample.externalSockets.length > 0 || sample.loopbackSockets.length > 0) {
        const { ledger: nextLedger, deltaIn, deltaOut } = updateTrafficLedger(trafficLedger, sample, sampleNow);
        trafficLedger = nextLedger;
        trafficCache.lastSample = sample;
        if (deltaIn > 0 || deltaOut > 0 || !trafficLastSavedAt) {
          trafficDirty = true;
        }
        if (trafficDirty && (sampleNow - trafficLastSavedAt >= 12_000 || (deltaIn + deltaOut) >= 256 * 1024)) {
          saveTrafficLedgerSync(trafficLedger);
          trafficLastSavedAt = sampleNow;
          trafficDirty = false;
        }
      }
      trafficCache.at = sampleNow;
    }
    trafficCache.snapshot = buildNetworkSnapshot(trafficLedger, trafficCache.lastSample, sampleNow);
    return trafficCache.snapshot;
  });
  return trafficCache.inflight;
}

// 后台兜底采样（即使面板标签切走也能持续接住关闭前的 HTTP/2 连接流量增量）
if (NETTOP_AVAILABLE) {
  const bgNetTimer = setInterval(async () => {
    if (Date.now() - trafficCache.at < 4500) return;
    try {
      const rows = await refreshPsRows();
      await refreshNetworkTraffic(rows, Date.now());
    } catch {
      // 静默忽略瞬态失败
    }
  }, 5000);
  bgNetTimer.unref?.();
}

// ---------------------------------------------------------------------------
// 全局全会话累计 Token 与缓存总账（增量磁盘缓存 + 异步分批扫描，绝不阻塞主请求）
// ---------------------------------------------------------------------------

const usageCachePath = join(sidecarDataDir, 'usage_cache.json');
let globalUsageEntries = new Map(); // `${appData}|${convId}` -> { appData, convId, sig, totals, byDate, mtime }
let globalUsageDirty = false;
let globalUsageLastSavedAt = 0;
let globalUsageScanState = {
  scanning: false,
  lastScanAt: 0,
  totalDbCount: 0,
  lastDirSig: '',
  version: 0,
};

const USAGE_CACHE_VERSION = 3;

function loadGlobalUsageCache() {
  try {
    if (!existsSync(usageCachePath)) return;
    const raw = JSON.parse(readFileSync(usageCachePath, 'utf-8'));
    if (raw?.version !== USAGE_CACHE_VERSION || !raw.entries || typeof raw.entries !== 'object') return;
    for (const [k, v] of Object.entries(raw.entries)) {
      if (v && typeof v === 'object' && v.sig && v.totals && v.convId) {
        globalUsageEntries.set(k, v);
      }
    }
  } catch {
    // 损坏缓存忽略重建
  }
}
loadGlobalUsageCache();

function saveGlobalUsageCacheSync() {
  try {
    mkdirSync(sidecarDataDir, { recursive: true });
    const entries = {};
    for (const [k, v] of globalUsageEntries.entries()) {
      entries[k] = v;
    }
    const tmp = `${usageCachePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: USAGE_CACHE_VERSION, entries }), 'utf-8');
    renameSync(tmp, usageCachePath);
  } catch (err) {
    console.error('[session-monitor] 保存全局用量缓存失败:', err.message);
  }
}

function scanSingleDbForGlobal(appData, convId, dbPath, sig) {
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 80 });
    const stepRows = db.prepare(
      'SELECT idx, metadata FROM steps WHERE step_type IN (15, 23) AND metadata IS NOT NULL',
    ).all();
    const stepCreatedAtMap = new Map();
    for (const r of stepRows) {
      if (!r?.metadata) continue;
      const ms = decodeStepCreatedAtMs(r.metadata);
      if (ms) stepCreatedAtMap.set(Number(r.idx), ms);
    }
    const genRows = db.prepare('SELECT data FROM gen_metadata ORDER BY idx ASC').all();
    const decoded = [];
    for (const r of genRows) {
      if (!r?.data) continue;
      const d = decodeGeneratorMetadataRow(r.data);
      if (d) decoded.push(d);
    }
    const st = statOf(dbPath);
    const agg = aggregateGeneratorRows(decoded, stepCreatedAtMap, {
      fallbackMs: st.mtime || Date.now(),
      includeStepMap: false,
    });
    return {
      appData,
      convId,
      sig,
      mtime: st.mtime || 0,
      totals: agg.totals,
      byDate: agg.byDate,
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

function scheduleGlobalUsageScan(now = Date.now()) {
  if (!DatabaseSync || globalUsageScanState.scanning) return;
  const appDataDirs = findAppDataDirs();
  const dirSig = appDataDirs
    .map((d) => `${d}:${statOf(join(d, 'conversations')).mtime}:${sqliteFileSig(join(d, 'conversation_summaries.db'))}`)
    .join('|');
  if (
    dirSig === globalUsageScanState.lastDirSig
    && now - globalUsageScanState.lastScanAt < GLOBAL_USAGE_SCAN_TTL_MS
  ) {
    return;
  }

  const pending = [];
  const aliveKeys = new Set();
  for (const appData of appDataDirs) {
    const convDir = join(appData, 'conversations');
    const files = safeReaddir(convDir);
    for (const f of files) {
      if (!f.endsWith('.db')) continue;
      const convId = f.slice(0, -3);
      if (!ID_RE.test(convId)) continue;
      const dbPath = join(convDir, f);
      const sig = sqliteFileSig(dbPath);
      if (!sig) continue;
      const key = `${appData}|${convId}`;
      aliveKeys.add(key);
      const existing = globalUsageEntries.get(key);
      if (!existing || existing.sig !== sig) {
        pending.push({ key, appData, convId, dbPath, sig });
      }
    }
  }

  // 清理已删除会话的缓存条目
  let pruned = false;
  for (const k of [...globalUsageEntries.keys()]) {
    if (!aliveKeys.has(k)) {
      globalUsageEntries.delete(k);
      pruned = true;
    }
  }
  if (pruned) {
    globalUsageDirty = true;
    globalUsageScanState.version += 1;
  }

  globalUsageScanState.totalDbCount = aliveKeys.size;
  globalUsageScanState.lastDirSig = dirSig;
  globalUsageScanState.lastScanAt = now;

  if (!pending.length) {
    if (globalUsageDirty && now - globalUsageLastSavedAt >= 15_000) {
      saveGlobalUsageCacheSync();
      globalUsageLastSavedAt = now;
      globalUsageDirty = false;
    }
    return;
  }

  // 优先扫描最近修改的 DB，每帧最多处理 5 个，确保事件循环零卡顿
  pending.sort((a, b) => statOf(b.dbPath).mtime - statOf(a.dbPath).mtime);
  globalUsageScanState.scanning = true;
  let cursor = 0;

  const processBatch = () => {
    const end = Math.min(pending.length, cursor + 5);
    let updatedAny = false;
    for (; cursor < end; cursor++) {
      const item = pending[cursor];
      const res = scanSingleDbForGlobal(item.appData, item.convId, item.dbPath, item.sig);
      if (res) {
        globalUsageEntries.set(item.key, res);
        updatedAny = true;
      }
    }
    if (updatedAny) {
      globalUsageDirty = true;
      globalUsageScanState.version += 1;
    }
    if (cursor < pending.length) {
      setImmediate(processBatch);
    } else {
      globalUsageScanState.scanning = false;
      globalUsageScanState.lastScanAt = Date.now();
      if (globalUsageDirty) {
        saveGlobalUsageCacheSync();
        globalUsageLastSavedAt = Date.now();
        globalUsageDirty = false;
      }
    }
  };
  setImmediate(processBatch);
}

function buildGlobalUsageSnapshot(now = Date.now()) {
  scheduleGlobalUsageScan(now);
  const todayKey = localDateKey(now);
  const { allTime, today, sessionRank, todayRank } = aggregateGlobalUsage(globalUsageEntries.values(), todayKey);

  const hydrateTopList = (rankArr) => {
    rankArr.sort((a, b) => b.totalTokens - a.totalTokens);
    const out = [];
    for (const s of rankArr) {
      if (out.length >= 5) break;
      const sumRow = getSummaryRow(s.appData, s.conversationId);
      if (!sumRow && !existsSync(join(s.appData, 'conversations', `${s.conversationId}.db`))) {
        continue;
      }
      const isSub = Boolean(sumRow?.parentConversationId || (sumRow?.nestingDepth || 0) > 0 || sumRow?.agentName);
      const wsName = sumRow?.workspacePaths?.[0] ? basename(sumRow.workspacePaths[0]) : '';
      out.push({
        conversationId: s.conversationId,
        title: sumRow?.title || `会话 ${s.conversationId.slice(0, 8)}`,
        workspaceName: wsName,
        isSubagent: isSub,
        totalTokens: s.totalTokens,
        cacheHitRate: s.cacheHitRate,
        apiCalls: s.apiCalls,
        output: s.output,
      });
    }
    return out;
  };

  const topSessions = hydrateTopList(sessionRank);
  const topSessionsToday = hydrateTopList(todayRank);

  return {
    available: Boolean(DatabaseSync),
    scanning: globalUsageScanState.scanning,
    scannedCount: globalUsageEntries.size,
    totalDbCount: globalUsageScanState.totalDbCount || globalUsageEntries.size,
    version: globalUsageScanState.version,
    allTime,
    today,
    topSessions,
    topSessionsToday,
  };
}

// ---------------------------------------------------------------------------
// 本地 `language_server` `GetUserStatus` 模型配额查询（60s TTL，失败静默降级）
// ---------------------------------------------------------------------------

let quotaCache = { at: 0, inflight: null, raw: null, version: 0 };

function resolveLanguageServerEndpoint() {
  const envAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const envCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (envAddr && envCsrf) {
    const addr = envAddr.startsWith('http://') || envAddr.startsWith('https://')
      ? envAddr.replace(/\/+$/, '')
      : `http://${envAddr.replace(/^localhost\b/, '127.0.0.1')}`;
    return { baseUrl: addr, csrfToken: envCsrf };
  }
  for (const appData of findAppDataDirs()) {
    const daemonDir = join(appData, 'daemon');
    const files = safeReaddir(daemonDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ full: join(daemonDir, f), mtime: statOf(join(daemonDir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of files) {
      try {
        const obj = JSON.parse(readFileSync(f.full, 'utf-8'));
        if (obj?.httpPort && obj?.csrfToken) {
          return { baseUrl: `http://127.0.0.1:${obj.httpPort}`, csrfToken: obj.csrfToken };
        }
      } catch {
        // 忽略无效文件
      }
    }
  }
  return null;
}

function triggerQuotaRefresh(now = Date.now()) {
  if (quotaCache.inflight) return quotaCache.inflight;
  if (quotaCache.at > 0 && now - quotaCache.at < QUOTA_TTL_MS) return Promise.resolve(quotaCache.raw);

  const ep = resolveLanguageServerEndpoint();
  if (!ep) {
    quotaCache.at = now;
    return Promise.resolve(quotaCache.raw);
  }

  quotaCache.inflight = fetch(
    `${ep.baseUrl}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': ep.csrfToken,
      },
      body: JSON.stringify({
        metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'zh-CN' },
      }),
      signal: AbortSignal.timeout(1800),
    },
  )
    .then((res) => (res.ok ? res.json() : null))
    .then((json) => {
      if (json && typeof json === 'object') {
        quotaCache.raw = json;
        quotaCache.version += 1;
      }
      quotaCache.at = Date.now();
      return quotaCache.raw;
    })
    .catch(() => {
      quotaCache.at = Date.now();
      return quotaCache.raw;
    })
    .finally(() => {
      quotaCache.inflight = null;
    });

  return quotaCache.inflight;
}

// ---------------------------------------------------------------------------
// Conversation Titles via `agentapi` (Async Cached)
// ---------------------------------------------------------------------------

const titleCache = new Map(); // convId -> string | Promise
function resolveConversationTitle(convId, fallback = '') {
  if (!convId || !ID_RE.test(convId)) return fallback;
  // When SQLite ground truth (`conversation_summaries.db`) is available, titles come directly from SQLite;
  // avoid spawning `agentapi get-conversation-metadata` which lacks titles and writes event log files.
  if (DatabaseSync) return fallback;
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
  if (!f.text) return { key: '-', data: null, mtime: f.mtime || 0, filePath: p };
  try {
    return { key: f.key, data: JSON.parse(f.text), mtime: f.mtime || 0, filePath: p };
  } catch {
    return { key: '-', data: null, mtime: f.mtime || 0, filePath: p };
  }
}

/**
 * Check whether `convId` still exists in Antigravity host storage.
 * Deleting a conversation in Antigravity removes its row from `conversation_summaries.db`,
 * removes `conversations/<id>.db`, and removes `brain/<id>`, but leaves behind our plugin's
 * `plugin_data/antigravity-session-monitor/sessions/<id>.json` hook file.
 */
function isConversationAlive(appData, convId, summaryMap, hookEntry, now) {
  if (!appData || !convId || !ID_RE.test(convId)) return false;
  if (summaryMap && summaryMap.has(convId)) return true;
  if (existsSync(join(appData, 'conversations', `${convId}.db`))) return true;
  if (!DatabaseSync || (!summaryMap && !existsSync(join(appData, 'conversations')))) {
    if (existsSync(join(appData, 'brain', convId))) return true;
  }
  const hookBirthMs = hookEntry?.data?.createdAt || hookEntry?.mtime || 0;
  if (hookBirthMs > 0 && now - hookBirthMs < 2500 && hookEntry?.data?.phase !== 'stopped') {
    return true;
  }
  return false;
}

function cleanupOrphanHookSession(appData, convId, now) {
  if (!appData || !convId || !ID_RE.test(convId)) return;
  const sessPath = join(appData, 'plugin_data', 'antigravity-session-monitor', 'sessions', `${convId}.json`);
  const st = statOf(sessPath);
  if (st.isFile && now - st.mtime > 3000) {
    try {
      unlinkSync(sessPath);
    } catch {
      // Ignore concurrent removal
    }
  }
  fileCache.delete(sessPath);
  const trPath = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  fileCache.delete(trPath);
  parsedTranscriptCache.delete(trPath);
  convDbCache.delete(join(appData, 'conversations', `${convId}.db`));
  convUsageCache.delete(join(appData, 'conversations', `${convId}.db`));
  titleCache.delete(convId);
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
        inCurrentTurn: true,
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
    const summaryMap = loadSummaryMap(d);
    if (
      summaryMap?.has(convId)
      || existsSync(join(d, 'conversations', `${convId}.db`))
      || existsSync(join(d, 'brain', convId))
    ) {
      return d;
    }
  }
  for (const d of dirs) {
    if (existsSync(join(d, 'plugin_data', 'antigravity-session-monitor', 'sessions', `${convId}.json`))) {
      return d;
    }
  }
  return dirs[0];
}

// ---------------------------------------------------------------------------
// Full & Lightweight Session Builders
// ---------------------------------------------------------------------------

function summarizeSubagent(appData, ref, psRows, now, summaryMap = null) {
  const subId = ref.conversationId;
  const hook = readHookSession(appData, subId);
  const effectiveSummaryMap = summaryMap || loadSummaryMap(appData);
  if (!isConversationAlive(appData, subId, effectiveSummaryMap, hook, now)) {
    cleanupOrphanHookSession(appData, subId, now);
    return null;
  }
  const runtimeMeta = readRuntimeMeta(appData, subId);
  const trEntry = getParsedTranscript(appData, subId, hook.data, runtimeMeta);
  const tr = trEntry.parsed;
  const subUsage = readConvUsageMetrics(appData, subId, runtimeMeta?.liveStepCount, runtimeMeta?.lastModifiedMs || tr.lastStepAtMs || 0);
  const effectiveWorkspacePaths = hook.data?.workspacePaths?.length
    ? hook.data.workspacePaths
    : (runtimeMeta?.workspacePaths || []);

  let proc = null;
  if (tr.pendingTools[0]?.name === 'run_command') {
    proc = matchActiveProcess(psRows, {
      commandLine: tr.pendingTools[0].commandLine,
      workspacePaths: effectiveWorkspacePaths,
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
  const uTotals = subUsage?.totals?.apiCalls ? subUsage.totals : null;
  const subTokens = uTotals
    ? {
      input: uTotals.input,
      cache: uTotals.cacheRead,
      cacheWrite: uTotals.cacheWrite,
      output: uTotals.output,
      thinkingOutput: uTotals.thinkingOutput,
      responseOutput: uTotals.responseOutput,
      total: uTotals.totalTokens,
      cacheHitRate: uTotals.cacheHitRate,
      currentContext: tr.tokens.currentContext,
    }
    : {
      ...tr.tokens,
      cacheWrite: 0,
      thinkingOutput: 0,
      responseOutput: 0,
    };

  return {
    conversationId: subId,
    role: ref.role || '子代理',
    typeName: ref.typeName || 'subagent',
    model: ref.model || health.modelName || subUsage?.latest?.modelDisplayName || '',
    state: health.state,
    severity: health.severity,
    badge: health.badge,
    headline: health.headline,
    detail: health.detail,
    elapsedSec: health.elapsedSec || 0,
    startedAtMs: health.startedAtMs || ref.startedAtMs || null,
    stepCount: tr.stepCount,
    apiCalls: uTotals?.apiCalls || 0,
    retries: uTotals?.retries || 0,
    modelCost: uTotals?.modelCost || 0,
    creditCost: uTotals?.creditCost || 0,
    hasThinkingBreakdown: Boolean(uTotals?.hasThinkingBreakdown),
    tokens: subTokens,
    tokenSpeed: tr.tokenSpeed,
    isRunning,
    inCurrentTurn: ref.inCurrentTurn !== false,
    key: `${hook.key}|${trEntry.key}|${subUsage?.sig || '-'}|${health.state}|${tr.tokenSpeed.latestTps ?? '-'}|${tr.tokenSpeed.turnLatestTps ?? '-'}`,
  };
}

function createEmptySnapshot(now, extra = {}) {
  return {
    conversationId: '',
    found: false,
    deleted: false,
    etagPart: 'empty',
    health: evaluateConversationHealth({ now, settings: userSettings }),
    milestones: null,
    subagents: [],
    bgTasks: [],
    rounds: [],
    tokens: {
      input: 0,
      cache: 0,
      cacheWrite: 0,
      output: 0,
      thinkingOutput: 0,
      responseOutput: 0,
      currentContext: 0,
      maxContextTokens: 0,
      contextUsagePercent: null,
      total: 0,
      grandTotalTokens: 0,
      grandTotalOutput: 0,
      cacheHitRate: null,
      latestCacheHitRate: null,
    },
    metrics: null,
    tokenSpeed: {
      latestTps: null,
      turnLatestTps: null,
      avgTps: null,
      turnAvgTps: null,
      peakTps: null,
      measuredRounds: 0,
    },
    ...extra,
  };
}

function buildConversationSnapshot(convId, psRows, now) {
  if (!convId || !ID_RE.test(convId)) {
    return createEmptySnapshot(now);
  }

  const appData = locateConversationAppData(convId);
  const summaryMap = loadSummaryMap(appData);
  const hook = readHookSession(appData, convId);
  if (!isConversationAlive(appData, convId, summaryMap, hook, now)) {
    cleanupOrphanHookSession(appData, convId, now);
    return createEmptySnapshot(now, {
      requestedConversationId: convId,
      deleted: true,
      etagPart: `deleted:${convId}`,
    });
  }

  const runtimeMeta = readRuntimeMeta(appData, convId);
  const trEntry = getParsedTranscript(appData, convId, hook.data, runtimeMeta);
  const tr = trEntry.parsed;
  const convUsage = readConvUsageMetrics(appData, convId, runtimeMeta?.liveStepCount, runtimeMeta?.lastModifiedMs || tr.lastStepAtMs || 0);
  const msEntry = readConversationMilestones(appData, convId);
  const effectiveWorkspacePaths = hook.data?.workspacePaths?.length
    ? hook.data.workspacePaths
    : (runtimeMeta?.workspacePaths || []);

  // Merge subagents from invoke_subagent + native swarm
  const subRefsMap = new Map();
  for (const r of tr.subagentRefs) subRefsMap.set(r.conversationId, r);
  for (const r of readSwarmSubagentRefs(appData, convId)) {
    if (!subRefsMap.has(r.conversationId)) subRefsMap.set(r.conversationId, r);
  }

  const subagents = [...subRefsMap.values()]
    .map((ref) => summarizeSubagent(appData, ref, psRows, now, summaryMap))
    .filter(Boolean);
  // Active / attention subagents first, then newest
  subagents.sort((a, b) => {
    const rank = (s) => (
      s.isRunning && (s.severity === 'danger' || s.severity === 'warning')
        ? 0
        : (s.isRunning ? 1 : 2)
    );
    return rank(a) - rank(b);
  });

  let proc = null;
  if (tr.pendingTools[0]?.name === 'run_command') {
    proc = matchActiveProcess(psRows, {
      commandLine: tr.pendingTools[0].commandLine,
      workspacePaths: effectiveWorkspacePaths,
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
  const workspaceName = effectiveWorkspacePaths[0]
    ? basename(effectiveWorkspacePaths[0])
    : '';

  // Aggregate total tokens & detailed API metrics including subagents
  const subTokens = subagents.reduce(
    (acc, s) => ({
      input: acc.input + (s.tokens?.input || 0),
      cache: acc.cache + (s.tokens?.cache || 0),
      cacheWrite: acc.cacheWrite + (s.tokens?.cacheWrite || 0),
      output: acc.output + (s.tokens?.output || 0),
      thinkingOutput: acc.thinkingOutput + (s.tokens?.thinkingOutput || 0),
      responseOutput: acc.responseOutput + (s.tokens?.responseOutput || 0),
      hasThinkingBreakdown: acc.hasThinkingBreakdown || Boolean(s.hasThinkingBreakdown),
      apiCalls: acc.apiCalls + (s.apiCalls || 0),
      retries: acc.retries + (s.retries || 0),
      modelCost: acc.modelCost + (s.modelCost || 0),
      creditCost: acc.creditCost + (s.creditCost || 0),
    }),
    {
      input: 0,
      cache: 0,
      cacheWrite: 0,
      output: 0,
      thinkingOutput: 0,
      responseOutput: 0,
      hasThinkingBreakdown: false,
      apiCalls: 0,
      retries: 0,
      modelCost: 0,
      creditCost: 0,
    },
  );

  const hasGenMeta = Boolean(convUsage?.totals?.apiCalls > 0);
  // 无 SQLite 降级到 transcript.jsonl 时，并入 CHECKPOINT 压缩步骤消耗的 Token，与 gen_metadata 口径对齐
  const cpTok = tr.checkpointTokens || { input: 0, cache: 0, output: 0 };
  const mainInput = hasGenMeta ? convUsage.totals.input : (tr.tokens.input + (cpTok.input || 0));
  const mainCacheRead = hasGenMeta ? convUsage.totals.cacheRead : (tr.tokens.cache + (cpTok.cache || 0));
  const mainCacheWrite = hasGenMeta ? convUsage.totals.cacheWrite : 0;
  const mainOutput = hasGenMeta ? convUsage.totals.output : (tr.tokens.output + (cpTok.output || 0));
  const mainThinkingOutput = hasGenMeta ? convUsage.totals.thinkingOutput : 0;
  const mainResponseOutput = hasGenMeta ? convUsage.totals.responseOutput : 0;
  const hasThinkingBreakdown = Boolean((hasGenMeta && convUsage.totals.hasThinkingBreakdown) || subTokens.hasThinkingBreakdown);
  const mainPromptTokens = mainInput + mainCacheRead + mainCacheWrite;
  const mainTotalTokens = mainPromptTokens + mainOutput;
  const subTotalTokens = subTokens.input + subTokens.cache + subTokens.cacheWrite + subTokens.output;
  const grandTotalTokens = mainTotalTokens + subTotalTokens;
  const mainCacheHitRate = computeCacheHitRate(mainInput, mainCacheRead, mainCacheWrite);
  const grandCacheHitRate = computeCacheHitRate(
    mainInput + subTokens.input,
    mainCacheRead + subTokens.cache,
    mainCacheWrite + subTokens.cacheWrite,
  );
  const latestCacheHitRate = hasGenMeta
    ? (convUsage.latest?.cacheHitRate ?? tr.tokens.latestCacheHitRate)
    : tr.tokens.latestCacheHitRate;
  const maxContextTokens = convUsage?.latest?.maxContextTokens || 0;
  // 若 transcript 缺失或超大未读出（stepCount === 0），回落至 gen_metadata 最新调用的上下文占用，不覆盖压缩后的合法归零态
  let currentContext = tr.tokens.currentContext;
  if (currentContext === 0 && tr.stepCount === 0 && convUsage?.latest) {
    currentContext = (convUsage.latest.input || 0)
      + (convUsage.latest.cacheRead || 0)
      + (convUsage.latest.cacheWrite || 0)
      || convUsage.latest.estimatedTokensUsed
      || 0;
  }
  const contextUsagePercent = maxContextTokens > 0 && currentContext > 0
    ? Math.min(100, Math.round((currentContext / maxContextTokens) * 1000) / 10)
    : null;
  const effectiveModelDisplay = convUsage?.latest?.modelDisplayName
    || hook.data?.modelName
    || tr.modelId
    || '';
  const totalModelCost = Math.round(((convUsage?.totals?.modelCost || 0) + subTokens.modelCost) * 10000) / 10000;
  const totalCreditCost = (convUsage?.totals?.creditCost || 0) + subTokens.creditCost;
  const latestPromptBytes = convUsage?.latest?.storedPromptBytes || 0;

  const sessionMetrics = {
    source: hasGenMeta ? 'sqlite_gen_metadata' : 'transcript',
    apiCalls: hasGenMeta ? convUsage.totals.apiCalls : tr.rounds.filter((r) => r.kind === 'planner').length,
    subagentApiCalls: subTokens.apiCalls,
    tokens: {
      input: mainInput,
      cacheRead: mainCacheRead,
      cacheWrite: mainCacheWrite,
      output: mainOutput,
      thinkingOutput: mainThinkingOutput,
      responseOutput: mainResponseOutput,
      hasThinkingBreakdown,
      promptTokens: mainPromptTokens,
      totalTokens: mainTotalTokens,
      currentContext,
      maxContextTokens,
      contextUsagePercent,
      latestPromptBytes,
      subagentInput: subTokens.input,
      subagentCacheRead: subTokens.cache,
      subagentCacheWrite: subTokens.cacheWrite,
      subagentOutput: subTokens.output,
      subagentThinkingOutput: subTokens.thinkingOutput,
      subagentResponseOutput: subTokens.responseOutput,
      subagentTotalTokens: subTotalTokens,
      grandTotalTokens,
      grandTotalOutput: mainOutput + subTokens.output,
    },
    cache: {
      hitRate: mainCacheHitRate,
      latestHitRate: latestCacheHitRate,
      grandHitRate: grandCacheHitRate,
      savedTokens: mainCacheRead + subTokens.cache,
      cacheWriteTokens: mainCacheWrite + subTokens.cacheWrite,
    },
    latency: {
      latestTtftMs: convUsage?.latest?.ttftMs ?? null,
      avgTtftMs: convUsage?.totals?.avgTtftMs ?? null,
      maxTtftMs: convUsage?.totals?.maxTtftMs ?? null,
      latestStreamMs: convUsage?.latest?.streamMs ?? null,
      avgStreamMs: convUsage?.totals?.avgStreamMs ?? null,
      latestDecodeTps: convUsage?.latest?.decodeTps ?? null,
      avgDecodeTps: convUsage?.totals?.decodeTps ?? null,
    },
    quality: {
      retries: (convUsage?.totals?.retries || 0) + subTokens.retries,
      modelCost: totalModelCost,
      creditCost: totalCreditCost,
      modelDisplayName: effectiveModelDisplay,
      responseModel: convUsage?.latest?.responseModel || tr.modelId || '',
    },
    contextBreakdown: convUsage?.latest?.tokenBreakdown || null,
  };

  const isEndedState = ['IDLE', 'COMPLETED', 'ERROR_STOPPED'].includes(health.state);
  const cascadeFullyStopped = Boolean(
    isEndedState
    || (hook.data?.phase === 'stopped' && hook.data?.stop?.fullyIdle)
    || (runtimeMeta && (runtimeMeta.killed || (runtimeMeta.cascadeStatus === 'CASCADE_RUN_STATUS_IDLE' && !runtimeMeta.notFullyIdle))),
  );
  const activeBgTasks = cascadeFullyStopped
    ? []
    : tr.bgTasks.filter((b) => b.status === 'running');

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
      currentContext,
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
    convUsage?.sig || '-',
    msEntry.key,
    health.state,
    health.badge,
    health.headline,
    cpuBucket,
    tr.tokenSpeed.latestTps ?? '-',
    tr.tokenSpeed.turnLatestTps ?? '-',
    tr.tokenSpeed.turnAvgTps ?? '-',
    activeSubagentTpsSum,
    activeBgTasks.length,
    compactHint?.level ?? '-',
    isCompacting ? 1 : 0,
    revertedStepsTotal,
    workspaceName,
    title,
    subagents.map((s) => s.key).join(','),
  ].join('|');

  // Return newest 40 rounds in reverse chronological order for the Timeline tab,
  // enriched with per-round API metrics (TTFT, decode TPS, cache hit rate, thinking tokens)
  const byStep = convUsage?.byStepIndex || null;
  const timelineRounds = tr.rounds.slice(-40).reverse().map((r) => {
    if (!byStep || r.stepIndex == null) return r;
    const am = byStep[r.stepIndex];
    if (!am) return r;
    return {
      ...r,
      apiMetrics: {
        input: am.input,
        cacheRead: am.cacheRead,
        output: am.output,
        cacheHitRate: am.cacheHitRate,
        ttftMs: am.ttftMs,
        streamMs: am.streamMs,
        decodeTps: am.decodeTps,
        thinkingOutput: am.thinkingOutput,
        responseOutput: am.responseOutput,
        cacheWrite: am.cacheWrite,
        retries: am.retries,
      },
    };
  });

  return {
    conversationId: convId,
    found: Boolean(hook.data || tr.stepCount > 0 || runtimeMeta || msEntry.milestones || hasGenMeta),
    deleted: false,
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
    bgTasks: activeBgTasks,
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
      decodeTps: convUsage?.totals?.decodeTps ?? null,
      latestDecodeTps: convUsage?.latest?.decodeTps ?? null,
    },
    tokens: {
      ...tr.tokens,
      currentContext,
      input: mainInput,
      cache: mainCacheRead,
      cacheWrite: mainCacheWrite,
      output: mainOutput,
      thinkingOutput: mainThinkingOutput,
      responseOutput: mainResponseOutput,
      total: mainTotalTokens,
      cacheHitRate: mainCacheHitRate,
      grandCacheHitRate,
      latestCacheHitRate,
      maxContextTokens,
      contextUsagePercent,
      latestPromptBytes,
      subagentInput: subTokens.input,
      subagentCache: subTokens.cache,
      subagentCacheWrite: subTokens.cacheWrite,
      subagentOutput: subTokens.output,
      grandTotalTokens,
      grandTotalOutput: mainOutput + subTokens.output,
    },
    metrics: sessionMetrics,
  };
}

// ---------------------------------------------------------------------------
// Global Parallel Sessions Scanner (Stat-invalidated + 1s TTL)
// ---------------------------------------------------------------------------

let globalCache = { at: 0, sig: '', items: [], key: '' };

function getGlobalSessions(psRows, now) {
  const appDataDirs = findAppDataDirs();
  const sigParts = [];
  for (const appData of appDataDirs) {
    const sumSig = sqliteFileSig(join(appData, 'conversation_summaries.db'));
    const sessSt = statOf(join(appData, 'plugin_data', 'antigravity-session-monitor', 'sessions'));
    const convDirSt = statOf(join(appData, 'conversations'));
    const brainDirSt = statOf(join(appData, 'brain'));
    sigParts.push(`${appData}:${sumSig}:${sessSt.mtime}:${convDirSt.mtime}:${brainDirSt.mtime}`);
  }
  const scanSig = sigParts.join('||');

  if (now - globalCache.at < GLOBAL_SCAN_TTL_MS && globalCache.sig === scanSig) {
    return globalCache;
  }

  const candidateIds = new Map(); // convId -> { appData, mtime, summaryMap }
  for (const appData of appDataDirs) {
    const summaryMap = loadSummaryMap(appData);
    if (summaryMap) {
      for (const [id, s] of summaryMap.entries()) {
        if (!ID_RE.test(id)) continue;
        if (s.parentConversationId || s.nestingDepth > 0 || s.agentName) continue;
        const isCascadeActive = Boolean(
          !s.killed && ((s.cascadeStatus && s.cascadeStatus !== 'CASCADE_RUN_STATUS_IDLE') || s.notFullyIdle),
        );
        const recentMs = Math.max(s.lastModifiedMs || 0, s.lastUserInputMs || 0);
        if (isCascadeActive || (recentMs > 0 && now - recentMs <= GLOBAL_LOOKBACK_MS)) {
          const effectiveMtime = isCascadeActive ? Math.max(recentMs, now - 1000) : recentMs;
          candidateIds.set(id, { appData, mtime: effectiveMtime, summaryMap });
        }
      }
    }

    const sessDir = join(appData, 'plugin_data', 'antigravity-session-monitor', 'sessions');
    for (const f of safeReaddir(sessDir)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      const hook = readHookSession(appData, id);
      if (!isConversationAlive(appData, id, summaryMap, hook, now)) {
        cleanupOrphanHookSession(appData, id, now);
        continue;
      }
      const sRow = summaryMap?.get(id);
      if (sRow && (sRow.parentConversationId || sRow.nestingDepth > 0 || sRow.agentName)) continue;
      const mtime = Math.max(hook.mtime || 0, hook.data?.updatedAt || 0);
      if (mtime > 0 && now - mtime <= GLOBAL_LOOKBACK_MS) {
        const prev = candidateIds.get(id);
        if (!prev || mtime > prev.mtime) candidateIds.set(id, { appData, mtime, summaryMap });
      }
    }

    const brainDir = join(appData, 'brain');
    for (const id of safeReaddir(brainDir)) {
      if (!ID_RE.test(id)) continue;
      if (!isConversationAlive(appData, id, summaryMap, null, now)) continue;
      const sRow = summaryMap?.get(id);
      if (sRow && (sRow.parentConversationId || sRow.nestingDepth > 0 || sRow.agentName)) continue;
      const tp = join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
      const mtime = statOf(tp).mtime;
      if (mtime > 0 && now - mtime <= GLOBAL_LOOKBACK_MS) {
        const prev = candidateIds.get(id);
        if (!prev || mtime > prev.mtime) candidateIds.set(id, { appData, mtime, summaryMap });
      }
    }
  }

  // Sort newest first and inspect top 20 recent live sessions
  const sorted = [...candidateIds.entries()]
    .sort((a, b) => b[1].mtime - a[1].mtime)
    .slice(0, 20);

  // Track child subagent IDs so we don't duplicate subagents as top-level conversations
  const childSubagentIds = new Set();
  const rawSummaries = [];

  for (const [id, { appData, mtime, summaryMap }] of sorted) {
    const hook = readHookSession(appData, id);
    if (!isConversationAlive(appData, id, summaryMap, hook, now)) {
      cleanupOrphanHookSession(appData, id, now);
      continue;
    }
    const runtimeMeta = readRuntimeMeta(appData, id);
    const trEntry = getParsedTranscript(appData, id, hook.data, runtimeMeta);
    const swarmRefs = readSwarmSubagentRefs(appData, id);
    for (const sr of trEntry.parsed.subagentRefs) {
      childSubagentIds.add(sr.conversationId);
    }
    for (const sr of swarmRefs) {
      childSubagentIds.add(sr.conversationId);
    }
    rawSummaries.push({ id, appData, mtime, summaryMap, hook, runtimeMeta, tr: trEntry.parsed, swarmRefs });
  }

  const items = [];
  for (const { id, appData, mtime, summaryMap, hook, runtimeMeta, tr, swarmRefs } of rawSummaries) {
    if (
      childSubagentIds.has(id)
      || runtimeMeta?.parentConversationId
      || (runtimeMeta?.nestingDepth || 0) > 0
      || runtimeMeta?.agentName
    ) {
      continue;
    }

    const effectiveWorkspacePaths = hook.data?.workspacePaths?.length
      ? hook.data.workspacePaths
      : (runtimeMeta?.workspacePaths || []);

    const subRefsMap = new Map();
    for (const sr of tr.subagentRefs) subRefsMap.set(sr.conversationId, sr);
    for (const sr of swarmRefs) {
      if (!subRefsMap.has(sr.conversationId)) subRefsMap.set(sr.conversationId, sr);
    }
    const subagents = subRefsMap.size > 0
      ? [...subRefsMap.values()]
        .map((ref) => summarizeSubagent(appData, ref, psRows, now, summaryMap))
        .filter(Boolean)
      : [];

    let proc = null;
    if (tr.pendingTools[0]?.name === 'run_command') {
      proc = matchActiveProcess(psRows, {
        commandLine: tr.pendingTools[0].commandLine,
        workspacePaths: effectiveWorkspacePaths,
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
    const msEntry = readConversationMilestones(appData, id);
    const rawFallbackTitle = runtimeMeta?.title || tr.titleCandidate || hook.data?.firstUserInput || hook.data?.lastUserInput || id.slice(0, 8);
    const fallbackTitle = String(rawFallbackTitle).replace(/^\/[a-zA-Z0-9_-]+\s+/, '');
    const title = runtimeMeta?.title || resolveConversationTitle(id, fallbackTitle);
    const workspaceName = effectiveWorkspacePaths[0]
      ? basename(effectiveWorkspacePaths[0])
      : '';

    // Terminated tasks (`IDLE`, `COMPLETED`, `ERROR_STOPPED`) belong to ended history, never "running tasks"
    const isActive = !['IDLE', 'COMPLETED', 'ERROR_STOPPED'].includes(health.state);
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

  // Sort: active attention/warning first, then active running, then ended sessions strictly by recency
  items.sort((a, b) => {
    const prio = (x) => {
      if (x.isActive && (x.severity === 'danger' || x.severity === 'warning' || x.severity === 'action_required')) return 0;
      if (x.isActive) return 1;
      return 2;
    };
    return (prio(a) - prio(b)) || (b.updatedAtMs - a.updatedAtMs);
  });

  const key = items.map(
    (i) => [
      i.conversationId,
      i.isActive ? 1 : 0,
      i.state,
      i.badge,
      i.headline,
      i.milestoneLabel,
      i.tokenSpeed?.latestTps ?? '-',
      i.tokenSpeed?.turnLatestTps ?? '-',
      i.compactHint?.level ?? '-',
      i.workspaceName,
      i.title,
    ].join(':'),
  ).join(';');
  globalCache = { at: now, sig: scanSig, items: items.slice(0, 12), key };
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

function flushDirtyStateSync() {
  if (trafficDirty) {
    saveTrafficLedgerSync(trafficLedger);
    trafficLastSavedAt = Date.now();
    trafficDirty = false;
  }
  if (globalUsageDirty) {
    saveGlobalUsageCacheSync();
    globalUsageLastSavedAt = Date.now();
    globalUsageDirty = false;
  }
}

for (const sigName of ['SIGTERM', 'SIGINT']) {
  process.on(sigName, () => {
    flushDirtyStateSync();
    process.exit(0);
  });
}
process.on('beforeExit', flushDirtyStateSync);

const BACKEND_FILES = [
  join(__dirname, 'main.mjs'),
  join(__dirname, 'state_engine.mjs'),
  join(__dirname, 'metrics_engine.mjs'),
];
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
    flushDirtyStateSync();
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
  const explicitNone = data?.conversationId === '__none__';
  const rawConv = explicitNone
    ? ''
    : (typeof data?.conversationId === 'string' && data.conversationId
      ? data.conversationId
      : (app.config.conversationId || ''));
  const convId = ID_RE.test(rawConv) ? rawConv : '';

  const psRows = await refreshPsRows();
  // 非阻塞触发配额刷新（60s TTL），同步异步采样 OS 网络流量（2.5s TTL）
  triggerQuotaRefresh(now);
  const network = await refreshNetworkTraffic(psRows, now);
  const current = buildConversationSnapshot(convId, psRows, now);
  const global = getGlobalSessions(psRows, now);
  const globalUsage = buildGlobalUsageSnapshot(now);
  const currentModelCandidates = [
    current.metrics?.quality?.modelDisplayName,
    current.metrics?.quality?.responseModel,
    current.health?.modelName,
  ].filter(Boolean);
  const quota = parseUserStatusQuota(quotaCache.raw, currentModelCandidates);
  const activeCount = global.items.filter((it) => it.isActive).length;
  const attentionCount = global.items.filter(
    (it) => it.isActive && (it.severity === 'warning' || it.severity === 'danger' || it.severity === 'action_required'),
  ).length;

  const uiBuildKey = computeUiBuildKey();
  const settingsKey = JSON.stringify(userSettings);
  const netEtag = network.available
    ? [
      network.todayDate,
      network.trackingSinceMs,
      network.allTime.in,
      network.allTime.out,
      network.today.in,
      network.today.out,
      network.liveExternal.in,
      network.liveExternal.out,
      network.liveExternal.count,
      network.liveExternal.proxyCount,
      network.liveLoopback.total,
      network.todayLoopback.total,
      network.allTimeLoopback?.total ?? 0,
      network.rates.inBps,
      network.rates.outBps,
    ].join(':')
    : 'na';
  const topTitleSig = (globalUsage.topSessions || []).map((s) => `${s.conversationId.slice(0, 8)}:${s.title}`).join(',');
  const topTodayTitleSig = (globalUsage.topSessionsToday || []).map((s) => `${s.conversationId.slice(0, 8)}:${s.title}`).join(',');
  const usageEtag = `${globalUsage.version}:${globalUsage.scanning ? 1 : 0}:${globalUsage.today.date}:${globalUsage.allTime.totalTokens}:${globalUsage.today.totalTokens}:${topTitleSig}|${topTodayTitleSig}`;
  const quotaEtag = `${quotaCache.version}:${quota?.currentModelQuota?.remainingPercent ?? '-'}`;
  const fullEtag = `${current.etagPart}||${global.key}||${netEtag}||${usageEtag}||${quotaEtag}||${settingsKey}||${uiBuildKey}`;

  if (data?.etag && data.etag === fullEtag) {
    return {
      unchanged: true,
      etag: fullEtag,
      uiBuildKey,
      serverNow: now,
      conversationId: current.conversationId,
    };
  }

  return {
    unchanged: false,
    etag: fullEtag,
    uiBuildKey,
    serverNow: now,
    conversationId: current.conversationId,
    settings: userSettings,
    current,
    network,
    globalUsage,
    quota,
    global: {
      activeCount,
      attentionCount,
      sessions: global.items,
    },
  };
};

app.api('/api/state', handleStateRequest, 'GET');

app.api('/api/traffic/reset', async () => {
  trafficResetGen += 1;
  let freshSample = null;
  if (NETTOP_AVAILABLE) {
    try {
      const psRows = await refreshPsRows();
      const res = await sampleNettopOnce(psRows, 1400);
      if (res?.sample) {
        freshSample = res.sample;
        trafficCache.lastSample = freshSample;
      }
    } catch {
      // 回落到保留既有高水位基线
    }
  }
  const now = Date.now();
  trafficLedger = resetTrafficLedger(trafficLedger, now, freshSample);
  saveTrafficLedgerSync(trafficLedger);
  trafficLastSavedAt = now;
  trafficDirty = false;
  trafficCache.at = now;
  trafficCache.snapshot = buildNetworkSnapshot(trafficLedger, trafficCache.lastSample, now);
  return { ok: true, network: trafficCache.snapshot };
}, 'POST');

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
  // 启动后立即预热全机用量扫描与配额查询，缩短首屏展示等待
  scheduleGlobalUsageScan(Date.now());
  triggerQuotaRefresh(Date.now());
});
