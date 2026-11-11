/**
 * Ultra-fast (<15ms) lifecycle hook collector for Antigravity Session Monitor.
 * Reads hook JSON payload from stdin, atomically updates session state under
 * <appData>/plugin_data/antigravity-session-monitor/sessions/<conversationId>.json, and outputs
 * a side-effect-free response to stdout.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const ID_RE = /^[0-9a-fA-F-]{8,64}$/;
const MAX_RECENT_EVENTS = 120;
const eventName = process.argv[2] || 'Unknown';
const defaultOut = eventName === 'Stop' ? '{"decision":"stop"}\n' : '{}\n';

function resolveAppDataDir(payload) {
  const tp = typeof payload?.transcriptPath === 'string' ? payload.transcriptPath : '';
  if (tp) {
    let cur = dirname(tp);
    for (let i = 0; i < 6 && cur && cur !== dirname(cur); i++) {
      if (basename(cur) === 'brain') {
        return dirname(cur);
      }
      cur = dirname(cur);
    }
  }
  const ad = typeof payload?.artifactDirectoryPath === 'string' ? payload.artifactDirectoryPath : '';
  if (ad) {
    let cur = dirname(ad);
    for (let i = 0; i < 4 && cur && cur !== dirname(cur); i++) {
      if (basename(cur) === 'brain') {
        return dirname(cur);
      }
      cur = dirname(cur);
    }
  }
  if (process.env.ANTIGRAVITY_APP_DATA_DIR) {
    return process.env.ANTIGRAVITY_APP_DATA_DIR;
  }
  if (process.env.PLUGIN_DATA) {
    // <appData>/plugin_data/<plugin>
    const p = dirname(process.env.PLUGIN_DATA);
    if (basename(p) === 'plugin_data') return dirname(p);
  }
  return join(homedir(), '.gemini', 'antigravity');
}

function unquote(v) {
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

function summarizeTool(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return '';
  const name = String(toolCall.name || '');
  const args = toolCall.args && typeof toolCall.args === 'object' ? toolCall.args : {};
  const summary = unquote(args.toolSummary || args.Role || '');
  if (summary) return summary.slice(0, 120);
  const path = unquote(args.Path || args.TargetFile || '');
  if (path) return `${name} ${basename(path)}`.slice(0, 120);
  const cmd = unquote(args.CommandLine || '');
  if (cmd) return cmd.replace(/\s+/g, ' ').slice(0, 100);
  return name;
}

function readStdinSync() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

try {
  const raw = readStdinSync();
  const payload = raw.trim() ? JSON.parse(raw) : {};
  const convId = typeof payload?.conversationId === 'string' ? payload.conversationId.trim() : '';

  if (convId && ID_RE.test(convId)) {
    const now = Date.now();
    const appData = resolveAppDataDir(payload);
    const sessionsDir = join(appData, 'plugin_data', 'antigravity-session-monitor', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    const targetPath = join(sessionsDir, `${convId}.json`);
    let prev = {};
    if (existsSync(targetPath)) {
      try {
        prev = JSON.parse(readFileSync(targetPath, 'utf-8')) || {};
      } catch {
        prev = {};
      }
    }

    const next = {
      ...prev,
      conversationId: convId,
      appDataDir: appData,
      workspacePaths: Array.isArray(payload.workspacePaths) ? payload.workspacePaths : (prev.workspacePaths || []),
      transcriptPath: payload.transcriptPath || prev.transcriptPath || '',
      artifactDirectoryPath: payload.artifactDirectoryPath || prev.artifactDirectoryPath || '',
      modelName: payload.modelName || prev.modelName || '',
      updatedAt: now,
    };

    if (typeof payload.lastUserInput === 'string' && payload.lastUserInput.trim()) {
      const cleaned = payload.lastUserInput
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
        .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
        .replace(/<\/?USER_REQUEST>/g, '')
        .trim();
      if (cleaned && cleaned !== prev.lastUserInput) {
        const cleanTopic = cleaned.replace(/^\/[a-zA-Z0-9_-]+\s+/, '').trim();
        if (!prev.firstUserInput && cleanTopic.length >= 4) {
          next.firstUserInput = cleanTopic.slice(0, 140);
        }
        next.lastUserInput = cleaned.slice(0, 280);
        // New user request resets the turn timer
        next.turnStartedAt = now;
        next.stop = null;
      }
    }

    const events = Array.isArray(prev.recentHookEvents) ? prev.recentHookEvents.slice(-(MAX_RECENT_EVENTS - 1)) : [];
    const evtRecord = { event: eventName, ts: now };

    if (eventName === 'SessionStart') {
      next.phase = 'session_start';
      next.sessionStartedAt = prev.sessionStartedAt || now;
    } else if (eventName === 'PreInvocation') {
      const invNum = Number.isFinite(payload.invocationNum) ? payload.invocationNum : ((prev.invocationNum || 0) + 1);
      if (!next.turnStartedAt || prev.phase === 'stopped' || invNum <= 1) {
        next.turnStartedAt = now;
      }
      next.phase = 'thinking';
      next.invocationStartedAt = now;
      next.invocationNum = invNum;
      next.initialNumSteps = payload.initialNumSteps ?? prev.initialNumSteps ?? 0;
      next.stop = null;
      evtRecord.invocationNum = invNum;
    } else if (eventName === 'PostToolUse') {
      next.phase = 'post_tool';
      const toolName = String(payload.toolCall?.name || '');
      const toolSummary = summarizeTool(payload.toolCall);
      const stepIdx = Number.isFinite(payload.stepIdx) ? payload.stepIdx : null;
      const errStr = typeof payload.error === 'string' ? payload.error.slice(0, 240) : '';
      next.lastTool = {
        name: toolName,
        summary: toolSummary,
        stepIdx,
        error: errStr,
        finishedAt: now,
      };
      evtRecord.toolName = toolName;
      evtRecord.summary = toolSummary;
      evtRecord.stepIdx = stepIdx;
      if (errStr) evtRecord.error = errStr;
    } else if (eventName === 'Stop') {
      next.phase = 'stopped';
      const reason = String(payload.terminationReason || 'NO_TOOL_CALL');
      const fullyIdle = payload.fullyIdle !== false;
      const errStr = typeof payload.error === 'string' ? payload.error.slice(0, 240) : '';
      next.stop = {
        terminationReason: reason,
        fullyIdle,
        error: errStr,
        executionNum: payload.executionNum ?? 1,
        stoppedAt: now,
      };
      evtRecord.terminationReason = reason;
      evtRecord.fullyIdle = fullyIdle;
      if (errStr) evtRecord.error = errStr;
    }

    events.push(evtRecord);
    next.recentHookEvents = events;

    const tmpPath = `${targetPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(next), 'utf-8');
    renameSync(tmpPath, targetPath);
  }
} catch {
  // Never fail or block the agent execution loop
}

process.stdout.write(defaultOut);
