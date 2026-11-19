/**
 * Antigravity 会话监控 · 流量、缓存命中率、接口遥测与配额纯函数解析引擎。
 *
 * 零第三方依赖，全部保持纯函数无副作用设计：
 * 1. 纯 JS 零拷贝 Protobuf 线格式解码器：解析宿主 `conversations/<id>.db` 的 `gen_metadata` 与 `steps.metadata`
 *    （提取缓存命中/写入、思考与正文输出拆分、TTFT 首字延迟、流式耗时、重试次数、上下文上限与模块占比等）。
 * 2. macOS `nettop` 套接字级解析与跨连接/跨重启无损持久化网络流量账本（精准剥离本地 IPC 回环，识别本地代理）。
 * 3. `GetUserStatus` 接口模型配额分组与当前模型匹配解析。
 */

// ---------------------------------------------------------------------------
// 通用格式化与比率计算
// ---------------------------------------------------------------------------

export function computeCacheHitRate(inputTokens, cacheReadTokens, cacheWriteTokens = 0) {
  const inp = Math.max(0, Number(inputTokens) || 0);
  const read = Math.max(0, Number(cacheReadTokens) || 0);
  const write = Math.max(0, Number(cacheWriteTokens) || 0);
  const denom = inp + read + write;
  if (denom <= 0) return null;
  const pct = (read / denom) * 100;
  return Math.min(100, Math.max(0, Math.round(pct * 10) / 10));
}

export function formatBytes(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b >= 100 * 1024 ? 0 : 1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(b >= 100 * 1024 * 1024 ? 1 : 2)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatByteRate(bps) {
  const v = Math.max(0, Number(bps) || 0);
  if (v < 1) return '0 B/s';
  if (v < 1024) return `${Math.round(v)} B/s`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(v >= 100 * 1024 ? 0 : 1)} KB/s`;
  return `${(v / (1024 * 1024)).toFixed(2)} MB/s`;
}

export function localDateKey(ms = Date.now()) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// 零依赖防御性 Protobuf 线格式解码器
// ---------------------------------------------------------------------------

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function readVarintBig(buf, pos, end) {
  let val = 0n;
  let shift = 0n;
  let i = pos;
  const limit = Math.min(end, pos + 10);
  while (i < limit) {
    const b = buf[i++];
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [val, i];
    shift += 7n;
  }
  return null;
}

function toSafeUint(bi) {
  if (bi < 0n || bi > MAX_SAFE_BIGINT) return 0;
  return Number(bi);
}

function skipWireField(buf, pos, end, wireType) {
  if (wireType === 0) {
    const r = readVarintBig(buf, pos, end);
    return r ? r[1] : end;
  }
  if (wireType === 1) return Math.min(end, pos + 8);
  if (wireType === 5) return Math.min(end, pos + 4);
  if (wireType === 2) {
    const r = readVarintBig(buf, pos, end);
    if (!r) return end;
    const len = toSafeUint(r[0]);
    return Math.min(end, r[1] + len);
  }
  return end;
}

function decodeUtf8(buf, start, end) {
  if (end <= start) return '';
  return Buffer.from(buf.buffer, buf.byteOffset + start, end - start).toString('utf-8');
}

function readFloat32LE(buf, pos, end) {
  if (pos + 4 > end) return 0;
  const dv = new DataView(buf.buffer, buf.byteOffset + pos, 4);
  const v = dv.getFloat32(0, true);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

function decodeDurationMs(buf, start, end) {
  let i = start;
  let sec = 0;
  let nanos = 0;
  let sawField = false;
  while (i < end) {
    const rt = readVarintBig(buf, i, end);
    if (!rt) break;
    const tag = toSafeUint(rt[0]);
    i = rt[1];
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (wt === 0) {
      const rv = readVarintBig(buf, i, end);
      if (!rv) break;
      if (fn === 1) {
        if (rv[0] > MAX_SAFE_BIGINT) return null;
        sec = toSafeUint(rv[0]);
        sawField = true;
      } else if (fn === 2) {
        if (rv[0] > MAX_SAFE_BIGINT) return null;
        nanos = toSafeUint(rv[0]);
        sawField = true;
      }
      i = rv[1];
    } else {
      const next = skipWireField(buf, i, end, wt);
      if (next <= i) break;
      i = next;
    }
  }
  if (!sawField) return null;
  const ms = sec * 1000 + Math.round(nanos / 1_000_000);
  return ms >= 0 && ms <= 3_600_000 ? ms : null;
}

function decodeTimestampMs(buf, start, end) {
  let i = start;
  let sec = 0;
  let nanos = 0;
  while (i < end) {
    const rt = readVarintBig(buf, i, end);
    if (!rt) break;
    const tag = toSafeUint(rt[0]);
    i = rt[1];
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (wt === 0) {
      const rv = readVarintBig(buf, i, end);
      if (!rv) break;
      if (fn === 1) sec = toSafeUint(rv[0]);
      else if (fn === 2) nanos = toSafeUint(rv[0]);
      i = rv[1];
    } else {
      const next = skipWireField(buf, i, end, wt);
      if (next <= i) break;
      i = next;
    }
  }
  // 合理 epoch 区间：2017-07 ~ 2099-12
  if (sec < 1_500_000_000 || sec > 4_100_000_000) return null;
  return sec * 1000 + Math.round(nanos / 1_000_000);
}

/**
 * 解析 `steps.metadata`（`CortexStepMetadata`）中的 `#1: created_at` 毫秒时间戳。
 */
export function decodeStepCreatedAtMs(rawBuf) {
  if (!rawBuf || !rawBuf.length) return null;
  const buf = rawBuf instanceof Uint8Array ? rawBuf : Buffer.from(rawBuf);
  let i = 0;
  const end = buf.length;
  while (i < end) {
    const rt = readVarintBig(buf, i, end);
    if (!rt) break;
    const tag = toSafeUint(rt[0]);
    i = rt[1];
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 2) {
      const rl = readVarintBig(buf, i, end);
      if (!rl) break;
      const len = toSafeUint(rl[0]);
      const p2 = rl[1];
      if (p2 + len > end) break;
      return decodeTimestampMs(buf, p2, p2 + len);
    }
    const next = skipWireField(buf, i, end, wt);
    if (next <= i) break;
    i = next;
  }
  return null;
}

function decodeModelUsageStats(buf, start, end) {
  let i = start;
  const usage = {
    modelEnum: 0,
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    apiProvider: 0,
    thinkingOutput: 0,
    responseOutput: 0,
    serviceTier: '',
  };
  while (i < end) {
    const rt = readVarintBig(buf, i, end);
    if (!rt) break;
    const tag = toSafeUint(rt[0]);
    i = rt[1];
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (wt === 0) {
      const rv = readVarintBig(buf, i, end);
      if (!rv) break;
      const v = toSafeUint(rv[0]);
      if (fn === 1) usage.modelEnum = v;
      else if (fn === 2) usage.input = v;
      else if (fn === 3) usage.output = v;
      else if (fn === 4) usage.cacheWrite = v;
      else if (fn === 5) usage.cacheRead = v;
      else if (fn === 6) usage.apiProvider = v;
      else if (fn === 9) usage.thinkingOutput = v;
      else if (fn === 10) usage.responseOutput = v;
      i = rv[1];
    } else if (wt === 2 && fn === 13) {
      const rl = readVarintBig(buf, i, end);
      if (!rl) break;
      const len = toSafeUint(rl[0]);
      const p2 = rl[1];
      if (p2 + len > end) break;
      usage.serviceTier = decodeUtf8(buf, p2, p2 + len);
      i = p2 + len;
    } else {
      const next = skipWireField(buf, i, end, wt);
      if (next <= i) break;
      i = next;
    }
  }
  return usage;
}

function decodeTopLevelTokenGroup(buf, start, end) {
  let i = start;
  let name = '';
  let type = 0;
  let numTokens = 0;
  while (i < end) {
    const rt = readVarintBig(buf, i, end);
    if (!rt) break;
    const tag = toSafeUint(rt[0]);
    i = rt[1];
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (wt === 0) {
      const rv = readVarintBig(buf, i, end);
      if (!rv) break;
      if (fn === 2) type = toSafeUint(rv[0]);
      else if (fn === 4) numTokens = toSafeUint(rv[0]);
      i = rv[1];
    } else if (wt === 2 && fn === 1) {
      const rl = readVarintBig(buf, i, end);
      if (!rl) break;
      const len = toSafeUint(rl[0]);
      const p2 = rl[1];
      if (p2 + len > end) break;
      name = decodeUtf8(buf, p2, p2 + len);
      i = p2 + len;
    } else {
      const next = skipWireField(buf, i, end, wt);
      if (next <= i) break;
      i = next;
    }
  }
  return numTokens > 0 ? { name: name || 'Other', type, numTokens } : null;
}

function decodeTokenBreakdown(buf, start, end) {
  let i = start;
  const groups = [];
  let totalTokens = 0;
  while (i < end) {
    const rt = readVarintBig(buf, i, end);
    if (!rt) break;
    const tag = toSafeUint(rt[0]);
    i = rt[1];
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (wt === 0 && fn === 2) {
      const rv = readVarintBig(buf, i, end);
      if (!rv) break;
      totalTokens = toSafeUint(rv[0]);
      i = rv[1];
    } else if (wt === 2 && fn === 1) {
      const rl = readVarintBig(buf, i, end);
      if (!rl) break;
      const len = toSafeUint(rl[0]);
      const p2 = rl[1];
      if (p2 + len > end) break;
      const g = decodeTopLevelTokenGroup(buf, p2, p2 + len);
      if (g) groups.push(g);
      i = p2 + len;
    } else {
      const next = skipWireField(buf, i, end, wt);
      if (next <= i) break;
      i = next;
    }
  }
  if (!groups.length && totalTokens <= 0) return null;
  return { groups, totalTokens: totalTokens || groups.reduce((s, g) => s + g.numTokens, 0) };
}

function decodeContextWindowMetadata(buf, start, end) {
  let i = start;
  let estimatedTokensUsed = 0;
  let maxContextTokens = 0;
  let tokenBreakdown = null;
  while (i < end) {
    const rt = readVarintBig(buf, i, end);
    if (!rt) break;
    const tag = toSafeUint(rt[0]);
    i = rt[1];
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (wt === 0) {
      const rv = readVarintBig(buf, i, end);
      if (!rv) break;
      if (fn === 1) estimatedTokensUsed = toSafeUint(rv[0]);
      else if (fn === 4) maxContextTokens = toSafeUint(rv[0]);
      i = rv[1];
    } else if (wt === 2 && fn === 3) {
      const rl = readVarintBig(buf, i, end);
      if (!rl) break;
      const len = toSafeUint(rl[0]);
      const p2 = rl[1];
      if (p2 + len > end) break;
      tokenBreakdown = decodeTokenBreakdown(buf, p2, p2 + len);
      i = p2 + len;
    } else {
      const next = skipWireField(buf, i, end, wt);
      if (next <= i) break;
      i = next;
    }
  }
  if (!estimatedTokensUsed && !maxContextTokens && !tokenBreakdown) return null;
  return { estimatedTokensUsed, maxContextTokens, tokenBreakdown };
}

function decodeChatStartMetadata(buf, start, end) {
  let i = start;
  let contextWindow = null;
  while (i < end) {
    const rt = readVarintBig(buf, i, end);
    if (!rt) break;
    const tag = toSafeUint(rt[0]);
    i = rt[1];
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (wt === 2 && fn === 10) {
      const rl = readVarintBig(buf, i, end);
      if (!rl) break;
      const len = toSafeUint(rl[0]);
      const p2 = rl[1];
      if (p2 + len > end) break;
      contextWindow = decodeContextWindowMetadata(buf, p2, p2 + len);
      i = p2 + len;
    } else {
      const next = skipWireField(buf, i, end, wt);
      if (next <= i) break;
      i = next;
    }
  }
  return contextWindow;
}

function decodeChatModelMetadata(buf, start, end) {
  let i = start;
  let usage = null;
  let ttftMs = null;
  let streamMs = null;
  let retries = 0;
  let modelCost = 0;
  let creditCost = 0;
  let modelDisplayName = '';
  let responseModel = '';
  let contextWindow = null;
  let storedPromptBytes = 0;

  while (i < end) {
    const rt = readVarintBig(buf, i, end);
    if (!rt) break;
    const tag = toSafeUint(rt[0]);
    i = rt[1];
    const fn = tag >>> 3;
    const wt = tag & 7;

    if (wt === 0) {
      const rv = readVarintBig(buf, i, end);
      if (!rv) break;
      if (fn === 13) creditCost = toSafeUint(rv[0]);
      else if (fn === 14) retries = toSafeUint(rv[0]);
      i = rv[1];
    } else if (wt === 5) {
      if (fn === 5) modelCost = readFloat32LE(buf, i, end);
      i = Math.min(end, i + 4);
    } else if (wt === 1) {
      i = Math.min(end, i + 8);
    } else if (wt === 2) {
      const rl = readVarintBig(buf, i, end);
      if (!rl) break;
      const len = toSafeUint(rl[0]);
      const p2 = rl[1];
      if (p2 + len > end) break;
      if (fn === 1 || fn === 2 || fn === 8 || fn === 16) {
        // system_prompt / message_prompts / tools / prompt_sections：仅累加字节数，不解码内容体
        storedPromptBytes += len;
      } else if (fn === 4) {
        usage = decodeModelUsageStats(buf, p2, p2 + len);
      } else if (fn === 9) {
        contextWindow = decodeChatStartMetadata(buf, p2, p2 + len);
      } else if (fn === 11) {
        ttftMs = decodeDurationMs(buf, p2, p2 + len);
      } else if (fn === 12) {
        streamMs = decodeDurationMs(buf, p2, p2 + len);
      } else if (fn === 19) {
        responseModel = decodeUtf8(buf, p2, p2 + len);
      } else if (fn === 21) {
        modelDisplayName = decodeUtf8(buf, p2, p2 + len);
      } else if (fn === 22 && !responseModel) {
        responseModel = decodeUtf8(buf, p2, p2 + len);
      }
      i = p2 + len;
    } else {
      break;
    }
  }

  return {
    usage,
    ttftMs,
    streamMs,
    retries,
    modelCost,
    creditCost,
    modelDisplayName: modelDisplayName || responseModel || '',
    responseModel,
    contextWindow,
    storedPromptBytes,
  };
}

/**
 * 解码 `conversations/<id>.db` 中单行 `gen_metadata.data`（`CortexStepGeneratorMetadata`）。
 */
export function decodeGeneratorMetadataRow(rawBuf) {
  if (!rawBuf || !rawBuf.length) return null;
  const buf = rawBuf instanceof Uint8Array ? rawBuf : Buffer.from(rawBuf);
  let i = 0;
  const end = buf.length;
  const stepIndices = [];
  let executionId = '';
  let chatModel = null;

  while (i < end) {
    const rt = readVarintBig(buf, i, end);
    if (!rt) break;
    const tag = toSafeUint(rt[0]);
    i = rt[1];
    const fn = tag >>> 3;
    const wt = tag & 7;

    if (wt === 0) {
      const rv = readVarintBig(buf, i, end);
      if (!rv) break;
      if (fn === 2) stepIndices.push(toSafeUint(rv[0]));
      i = rv[1];
    } else if (wt === 2) {
      const rl = readVarintBig(buf, i, end);
      if (!rl) break;
      const len = toSafeUint(rl[0]);
      const p2 = rl[1];
      if (p2 + len > end) break;
      if (fn === 1) {
        chatModel = decodeChatModelMetadata(buf, p2, p2 + len);
      } else if (fn === 2) {
        let j = p2;
        const pEnd = p2 + len;
        while (j < pEnd) {
          const rv = readVarintBig(buf, j, pEnd);
          if (!rv) break;
          stepIndices.push(toSafeUint(rv[0]));
          j = rv[1];
        }
      } else if (fn === 4) {
        executionId = decodeUtf8(buf, p2, p2 + len);
      }
      i = p2 + len;
    } else {
      const next = skipWireField(buf, i, end, wt);
      if (next <= i) break;
      i = next;
    }
  }

  if (!chatModel) return null;
  return {
    stepIndices,
    executionId,
    ...chatModel,
  };
}

const CONTEXT_GROUP_LABEL_ZH = Object.freeze({
  'Chat Messages': '对话历史',
  'Tools': '工具定义',
  'Mcp Tools': 'MCP 工具',
  'MCP Tools': 'MCP 工具',
  'Skills': '技能说明',
  'Rules': '用户规则',
  'Plugins': '插件',
  'Subagents': '子代理',
  'System Prompt': '系统提示',
  'Memory': '记忆上下文',
  'Knowledge': '知识库',
  'Unspecified': '基础指令',
});

function localizeTokenBreakdown(tb) {
  if (!tb || !Array.isArray(tb.groups) || !tb.groups.length) return null;
  const total = tb.totalTokens || tb.groups.reduce((s, g) => s + (g.numTokens || 0), 0);
  if (total <= 0) return null;
  const merged = new Map();
  for (const g of tb.groups) {
    const label = CONTEXT_GROUP_LABEL_ZH[g.name] || g.name || '其他';
    merged.set(label, (merged.get(label) || 0) + (g.numTokens || 0));
  }
  const items = [...merged.entries()]
    .map(([label, tokens]) => ({
      label,
      tokens,
      percent: Math.round((tokens / total) * 1000) / 10,
    }))
    .sort((a, b) => b.tokens - a.tokens);
  return { totalTokens: total, items };
}

/**
 * 聚合单个会话所有 `gen_metadata` 行，产出：
 * - totals：会话累计 Token、缓存命中率、思考/正文拆分、TTFT、流式耗时、解码速率、重试次数、费用/积分
 * - latest：最新一轮（遵循 liveStepCount 过滤已撤回上下文）的缓存命中率、TTFT、上下文上限与构成拆解
 * - byStepIndex：每个步骤索引对应的接口指标（供执行轨迹页签展示每轮缓存命中率与 TTFT）
 * - byDate：按本地日期 `YYYY-MM-DD` 精确分桶的调用统计（供全机「今日」汇总使用）
 */
export function aggregateGeneratorRows(decodedRows, stepCreatedAtMap = null, options = {}) {
  const rows = Array.isArray(decodedRows) ? decodedRows : [];
  const liveStepCount = Number.isFinite(options.liveStepCount) && options.liveStepCount >= 0
    ? options.liveStepCount
    : null;
  const fallbackDateKey = options.fallbackDateKey || localDateKey(options.fallbackMs || Date.now());
  const includeStepMap = options.includeStepMap !== false;

  const totals = {
    apiCalls: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    thinkingOutput: 0,
    responseOutput: 0,
    hasThinkingBreakdown: false,
    totalTokens: 0,
    promptTokens: 0,
    cacheHitRate: null,
    retries: 0,
    modelCost: 0,
    creditCost: 0,
    ttftSumMs: 0,
    ttftCount: 0,
    avgTtftMs: null,
    maxTtftMs: null,
    streamSumMs: 0,
    streamCount: 0,
    streamOutTokens: 0,
    avgStreamMs: null,
    decodeTps: null,
  };

  let latest = null;
  let latestActiveContext = null;
  let latestActivePromptBytes = 0;
  let lastKnownCallMs = null;
  const byStepIndex = includeStepMap ? {} : null;
  const byDate = {};

  for (const r of rows) {
    if (!r || !r.usage) continue;
    const u = r.usage;
    const inTok = u.input || 0;
    const crTok = u.cacheRead || 0;
    const cwTok = u.cacheWrite || 0;
    const outTok = u.output || 0;
    const thinkTok = u.thinkingOutput || 0;
    const respTok = u.responseOutput || 0;
    const retries = r.retries || 0;
    const cost = r.modelCost || 0;
    const credits = r.creditCost || 0;

    totals.apiCalls += 1;
    totals.input += inTok;
    totals.cacheRead += crTok;
    totals.cacheWrite += cwTok;
    totals.output += outTok;
    totals.thinkingOutput += thinkTok;
    totals.responseOutput += respTok;
    if (thinkTok > 0 || respTok > 0) totals.hasThinkingBreakdown = true;
    totals.retries += retries;
    totals.modelCost += cost;
    totals.creditCost += credits;

    const hasValidTtft = Number.isFinite(r.ttftMs) && r.ttftMs >= 0;
    if (hasValidTtft) {
      totals.ttftSumMs += r.ttftMs;
      totals.ttftCount += 1;
      if (totals.maxTtftMs == null || r.ttftMs > totals.maxTtftMs) {
        totals.maxTtftMs = r.ttftMs;
      }
    }
    let rowDecodeTps = null;
    const hasValidStream = Number.isFinite(r.streamMs) && r.streamMs >= 50 && r.streamMs <= 600_000;
    if (hasValidStream) {
      totals.streamSumMs += r.streamMs;
      totals.streamCount += 1;
      if (outTok > 0) {
        totals.streamOutTokens += outTok;
        rowDecodeTps = Math.round((outTok / (r.streamMs / 1000)) * 10) / 10;
      }
    }

    const rowHitRate = computeCacheHitRate(inTok, crTok, cwTok);
    const primaryStepIdx = r.stepIndices?.length ? r.stepIndices[0] : null;
    const isRevertedStep = liveStepCount != null && primaryStepIdx != null && primaryStepIdx >= liveStepCount;

    if (includeStepMap && Array.isArray(r.stepIndices)) {
      const stepStat = {
        input: inTok,
        cacheRead: crTok,
        cacheWrite: cwTok,
        output: outTok,
        thinkingOutput: thinkTok,
        responseOutput: respTok,
        cacheHitRate: rowHitRate,
        ttftMs: r.ttftMs,
        streamMs: r.streamMs,
        decodeTps: rowDecodeTps,
        retries,
        modelDisplayName: r.modelDisplayName || '',
      };
      for (const sIdx of r.stepIndices) {
        byStepIndex[sIdx] = stepStat;
      }
    }

    // 确定此调用所属日期桶（若当前行对应步骤已撤回缺失时间戳，沿用最近已知步骤时间再回落文件修改时间）
    let callMs = null;
    if (stepCreatedAtMap && Array.isArray(r.stepIndices)) {
      for (const sIdx of r.stepIndices) {
        const ms = stepCreatedAtMap instanceof Map ? stepCreatedAtMap.get(sIdx) : stepCreatedAtMap[sIdx];
        if (Number.isFinite(ms) && ms > 0) {
          callMs = ms;
          break;
        }
      }
    }
    if (callMs) {
      lastKnownCallMs = callMs;
    } else if (lastKnownCallMs) {
      callMs = lastKnownCallMs;
    }
    const dateKey = callMs ? localDateKey(callMs) : fallbackDateKey;
    if (!byDate[dateKey]) {
      byDate[dateKey] = {
        apiCalls: 0,
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        thinkingOutput: 0,
        responseOutput: 0,
        retries: 0,
        modelCost: 0,
        creditCost: 0,
        ttftSumMs: 0,
        ttftCount: 0,
        maxTtftMs: null,
        streamSumMs: 0,
        streamCount: 0,
        streamOutTokens: 0,
      };
    }
    const bucket = byDate[dateKey];
    bucket.apiCalls += 1;
    bucket.input += inTok;
    bucket.cacheRead += crTok;
    bucket.cacheWrite += cwTok;
    bucket.output += outTok;
    bucket.thinkingOutput += thinkTok;
    bucket.responseOutput += respTok;
    bucket.retries += retries;
    bucket.modelCost += cost;
    bucket.creditCost += credits;
    if (hasValidTtft) {
      bucket.ttftSumMs += r.ttftMs;
      bucket.ttftCount += 1;
      if (bucket.maxTtftMs == null || r.ttftMs > bucket.maxTtftMs) {
        bucket.maxTtftMs = r.ttftMs;
      }
    }
    if (hasValidStream) {
      bucket.streamSumMs += r.streamMs;
      bucket.streamCount += 1;
      if (outTok > 0) bucket.streamOutTokens += outTok;
    }

    const latestCandidate = {
      cacheHitRate: rowHitRate,
      input: inTok,
      cacheRead: crTok,
      cacheWrite: cwTok,
      output: outTok,
      thinkingOutput: thinkTok,
      responseOutput: respTok,
      ttftMs: r.ttftMs,
      streamMs: r.streamMs,
      decodeTps: rowDecodeTps,
      retries,
      modelDisplayName: r.modelDisplayName || '',
      responseModel: r.responseModel || '',
      maxContextTokens: r.contextWindow?.maxContextTokens || 0,
      estimatedTokensUsed: r.contextWindow?.estimatedTokensUsed || 0,
      tokenBreakdown: localizeTokenBreakdown(r.contextWindow?.tokenBreakdown),
      storedPromptBytes: r.storedPromptBytes || 0,
    };

    if (!isRevertedStep) {
      latest = latestCandidate;
      if (r.storedPromptBytes > 0) latestActivePromptBytes = r.storedPromptBytes;
      if (r.contextWindow) {
        latestActiveContext = {
          maxContextTokens: r.contextWindow.maxContextTokens || 0,
          estimatedTokensUsed: r.contextWindow.estimatedTokensUsed || 0,
          tokenBreakdown: latestCandidate.tokenBreakdown,
        };
      }
    } else if (!latest) {
      latest = latestCandidate;
    }
  }

  totals.promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
  totals.totalTokens = totals.promptTokens + totals.output;
  totals.cacheHitRate = computeCacheHitRate(totals.input, totals.cacheRead, totals.cacheWrite);
  totals.avgTtftMs = totals.ttftCount > 0 ? Math.round(totals.ttftSumMs / totals.ttftCount) : null;
  totals.avgStreamMs = totals.streamCount > 0 ? Math.round(totals.streamSumMs / totals.streamCount) : null;
  totals.decodeTps = totals.streamSumMs > 0 && totals.streamOutTokens > 0
    ? Math.round((totals.streamOutTokens / (totals.streamSumMs / 1000)) * 10) / 10
    : null;
  totals.modelCost = Math.round(totals.modelCost * 10000) / 10000;
  for (const b of Object.values(byDate)) {
    b.modelCost = Math.round((b.modelCost || 0) * 10000) / 10000;
  }

  if (latest) {
    if (latestActiveContext) {
      if (!latest.maxContextTokens && latestActiveContext.maxContextTokens) {
        latest.maxContextTokens = latestActiveContext.maxContextTokens;
      }
      if (!latest.tokenBreakdown && latestActiveContext.tokenBreakdown) {
        latest.tokenBreakdown = latestActiveContext.tokenBreakdown;
      }
    }
    if (!latest.storedPromptBytes && latestActivePromptBytes > 0) {
      latest.storedPromptBytes = latestActivePromptBytes;
    }
  }

  return {
    totals,
    latest,
    byStepIndex,
    byDate,
  };
}

/**
 * 汇总全机所有会话的累计与当日用量桶（含全局 TTFT、流式解码速率、模型费用与积分），
 * 并输出未水合的会话消耗排行列表供后端补全标题与工作区信息。
 */
export function aggregateGlobalUsage(entriesIterable, todayKey = localDateKey(Date.now())) {
  const makeBucket = (extra = {}) => ({
    ...extra,
    conversationCount: 0,
    apiCalls: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    thinkingOutput: 0,
    responseOutput: 0,
    hasThinkingBreakdown: false,
    promptTokens: 0,
    totalTokens: 0,
    cacheHitRate: null,
    retries: 0,
    modelCost: 0,
    creditCost: 0,
    ttftSumMs: 0,
    ttftCount: 0,
    avgTtftMs: null,
    maxTtftMs: null,
    streamSumMs: 0,
    streamCount: 0,
    streamOutTokens: 0,
    avgStreamMs: null,
    decodeTps: null,
  });

  const accumulateBucket = (dst, src) => {
    dst.conversationCount += 1;
    dst.apiCalls += src.apiCalls || 0;
    dst.input += src.input || 0;
    dst.cacheRead += src.cacheRead || 0;
    dst.cacheWrite += src.cacheWrite || 0;
    dst.output += src.output || 0;
    dst.thinkingOutput += src.thinkingOutput || 0;
    dst.responseOutput += src.responseOutput || 0;
    if (src.hasThinkingBreakdown || (src.thinkingOutput || 0) > 0 || (src.responseOutput || 0) > 0) {
      dst.hasThinkingBreakdown = true;
    }
    dst.retries += src.retries || 0;
    dst.modelCost += src.modelCost || 0;
    dst.creditCost += src.creditCost || 0;

    if (Number.isFinite(src.ttftSumMs) && src.ttftSumMs >= 0 && Number.isFinite(src.ttftCount) && src.ttftCount > 0) {
      dst.ttftSumMs += src.ttftSumMs;
      dst.ttftCount += src.ttftCount;
    }
    if (Number.isFinite(src.maxTtftMs) && src.maxTtftMs >= 0) {
      if (dst.maxTtftMs == null || src.maxTtftMs > dst.maxTtftMs) {
        dst.maxTtftMs = src.maxTtftMs;
      }
    }
    if (Number.isFinite(src.streamSumMs) && src.streamSumMs > 0) {
      dst.streamSumMs += src.streamSumMs;
      dst.streamCount += Number.isFinite(src.streamCount) && src.streamCount > 0 ? src.streamCount : 0;
      if (Number.isFinite(src.streamOutTokens) && src.streamOutTokens > 0) {
        dst.streamOutTokens += src.streamOutTokens;
      }
    }
  };

  const finalizeBucket = (b) => {
    b.promptTokens = b.input + b.cacheRead + b.cacheWrite;
    b.totalTokens = b.promptTokens + b.output;
    b.cacheHitRate = computeCacheHitRate(b.input, b.cacheRead, b.cacheWrite);
    b.modelCost = Math.round(b.modelCost * 10000) / 10000;
    b.avgTtftMs = b.ttftCount > 0 ? Math.round(b.ttftSumMs / b.ttftCount) : null;
    b.avgStreamMs = b.streamCount > 0 ? Math.round(b.streamSumMs / b.streamCount) : null;
    b.decodeTps = b.streamSumMs > 0 && b.streamOutTokens > 0
      ? Math.round((b.streamOutTokens / (b.streamSumMs / 1000)) * 10) / 10
      : null;
  };

  const allTime = makeBucket();
  const today = makeBucket({ date: todayKey });
  const sessionRank = [];
  const todayRank = [];

  for (const entry of entriesIterable || []) {
    const t = entry?.totals;
    if (!t || !t.apiCalls) continue;
    accumulateBucket(allTime, t);

    const tb = entry.byDate?.[todayKey];
    if (tb && tb.apiCalls > 0) {
      accumulateBucket(today, tb);
      const tbTotal = (tb.input || 0) + (tb.cacheRead || 0) + (tb.cacheWrite || 0) + (tb.output || 0);
      todayRank.push({
        appData: entry.appData,
        conversationId: entry.convId,
        totalTokens: tbTotal,
        cacheHitRate: computeCacheHitRate(tb.input, tb.cacheRead, tb.cacheWrite),
        apiCalls: tb.apiCalls || 0,
        output: tb.output || 0,
      });
    }

    sessionRank.push({
      appData: entry.appData,
      conversationId: entry.convId,
      totalTokens: t.totalTokens || ((t.input || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0) + (t.output || 0)),
      cacheHitRate: t.cacheHitRate ?? computeCacheHitRate(t.input, t.cacheRead, t.cacheWrite),
      apiCalls: t.apiCalls || 0,
      output: t.output || 0,
    });
  }

  finalizeBucket(allTime);
  finalizeBucket(today);

  return { allTime, today, sessionRank, todayRank };
}

// ---------------------------------------------------------------------------
// macOS `nettop` 套接字级解析与持久化网络流量账本
// ---------------------------------------------------------------------------

const AGY_PROC_CMD_RE = /(?:\/Antigravity\.app\/|\/language_server(?:_[a-z0-9_]+)?(?:\s|$))/i;
const AGY_NETTOP_NAME_FALLBACK_RE = /^(?:Antigravity|language_server)/i;
const PROXY_PROC_NAME_RE = /(?:clash|mihomo|surge|v2ray|xray|sing-box|singbox|stash|shadowrocket|shadowsocks|ss-local|sslocal|loon|privoxy|hiddify|flclash|verge|nekoray|nekobox|karing|qv2ray|proxifier|proxyman|mitmproxy|charles|whistle|reqable|tinyproxy|polipo|trojan|naive|tuic|hysteria|leaf|juicity|brook|gost|glider|snell|tailscaled|mullvad|warp|outline)/i;

/**
 * 从 `ps` 进程表识别所有 Antigravity 宿主自身进程（主进程、Helper、language_server），
 * 并排除当前监控插件自身与用户通过 `run_command` 启动的普通终端子进程，避免误算外部命令流量。
 */
export function identifyAntigravityPids(psRows, options = {}) {
  const agyPids = new Set();
  const procLabels = new Map();
  const ownPid = Number.isFinite(options?.ownPid) ? options.ownPid : -1;
  if (!Array.isArray(psRows)) return { agyPids, procLabels };

  for (const r of psRows) {
    if (!r || !Number.isFinite(r.pid) || typeof r.command !== 'string') continue;
    if (r.pid === ownPid) continue;
    // 排除本监控插件、其他 UI 插件 sidecar 与钩子脚本，确保只统计 Antigravity 宿主自身进程
    if (
      r.command.includes('session_monitor')
      || r.command.includes('hook_collector.mjs')
      || r.command.includes('sidecar_sdk/register_loader.js')
    ) {
      continue;
    }
    if (AGY_PROC_CMD_RE.test(r.command)) {
      agyPids.add(r.pid);
      let label = 'Antigravity';
      if (/language_server/i.test(r.command)) {
        label = 'language_server';
      } else if (/network\.mojom\.NetworkService/i.test(r.command)) {
        label = 'Antigravity Network';
      } else if (/Antigravity Helper/i.test(r.command)) {
        label = 'Antigravity Helper';
      }
      procLabels.set(r.pid, label);
    }
  }
  return { agyPids, procLabels };
}

/**
 * 从完整 `ps` 命令行中识别本机代理进程 PID 集合（规避 macOS `nettop` 仅保留 15 字符进程名截断的问题）。
 */
export function identifyProxyPids(psRows) {
  const proxyPids = new Set();
  if (!Array.isArray(psRows)) return proxyPids;
  for (const r of psRows) {
    if (!r || !Number.isFinite(r.pid) || typeof r.command !== 'string') continue;
    if (AGY_PROC_CMD_RE.test(r.command)) continue;
    if (PROXY_PROC_NAME_RE.test(r.command)) {
      proxyPids.add(r.pid);
    }
  }
  return proxyPids;
}

/**
 * 从环境变量提取本地代理端口集合（HTTP_PROXY / HTTPS_PROXY / ALL_PROXY）。
 */
export function extractProxyPortsFromEnv(env = {}) {
  const ports = new Set();
  if (!env || typeof env !== 'object') return ports;
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    const raw = env[key];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
      const port = Number(u.port);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        ports.add(port);
      }
    } catch {
      // 忽略畸形代理配置
    }
  }
  return ports;
}

/**
 * 解析 macOS `scutil --proxy` 输出，提取当前已启用的系统代理端口（HTTP/HTTPS/SOCKS）。
 */
export function parseScutilProxyPorts(scutilText) {
  const ports = new Set();
  if (typeof scutilText !== 'string' || !scutilText.trim()) return ports;
  const kv = new Map();
  for (const line of scutilText.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) kv.set(m[1], m[2]);
  }
  const addIfEnabled = (enableKey, portKey) => {
    if (kv.get(enableKey) !== '1') return;
    const port = Number(kv.get(portKey));
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  };
  addIfEnabled('HTTPEnable', 'HTTPPort');
  addIfEnabled('HTTPSEnable', 'HTTPSPort');
  addIfEnabled('SOCKSEnable', 'SOCKSPort');
  return ports;
}

function splitEndpointHostPort(ep) {
  if (!ep || ep === '*:*' || ep === '*.*') return { host: '*', port: null };
  const s = ep.trim();
  // [::1]:7890
  const bracketM = /^\[([^\]]+)\]:(\d+)$/.exec(s);
  if (bracketM) return { host: bracketM[1], port: Number(bracketM[2]) };
  // IPv4 host:port 或 *:7890
  const colonParts = s.split(':');
  if (colonParts.length === 2 && /^\d+$/.test(colonParts[1])) {
    return { host: colonParts[0], port: Number(colonParts[1]) };
  }
  // macOS nettop IPv6 格式：::1.56708 / fe80::1%lo0.56708 / *.7890
  const dotM = /^(.+)\.(\d+)$/.exec(s);
  if (dotM) return { host: dotM[1], port: Number(dotM[2]) };
  return { host: s, port: null };
}

function isLoopbackOrWildcardHost(host) {
  if (!host || host === '*' || host === '0.0.0.0' || host === '::') return true;
  const h = host.toLowerCase();
  if (h === '127.0.0.1' || h.startsWith('127.') || h === '::1' || h.startsWith('::1%')) return true;
  // 链路本地与局域网组播（mDNS / Bonjour / SSDP）不计入外网流量
  if (
    h.startsWith('fe80:')
    || h.startsWith('ff01:')
    || h.startsWith('ff02:')
    || h.startsWith('169.254.')
    || h.startsWith('224.0.0.')
    || h.startsWith('239.255.255.')
    || h === '255.255.255.255'
  ) {
    return true;
  }
  return false;
}

function parseSocketEndpoints(socketDesc) {
  // 例："tcp4 192.168.0.130:50341<->198.18.0.18:443" 或 "tcp4 127.0.0.1:56679<->*:*"
  const spaceIdx = socketDesc.indexOf(' ');
  const body = spaceIdx >= 0 ? socketDesc.slice(spaceIdx + 1) : socketDesc;
  const arrowIdx = body.indexOf('<->');
  if (arrowIdx < 0) {
    return { left: '', right: '', localHost: '', localPort: null, remoteHost: '', remotePort: null };
  }
  const left = body.slice(0, arrowIdx).trim();
  const right = body.slice(arrowIdx + 3).trim();
  const l = splitEndpointHostPort(left);
  const r = splitEndpointHostPort(right);
  return {
    left,
    right,
    localHost: l.host,
    localPort: l.port,
    remoteHost: r.host,
    remotePort: r.port,
  };
}

/**
 * 解析 `nettop -L 1 -n -J interface,state,bytes_in,bytes_out -x` 输出，
 * 精准区分 Antigravity 的真实外网流量（含本地代理转发与 QUIC/UDP 外网连接）与本地 IPC 回环流量（自动去重双向套接字）。
 */
export function parseNettopSockets(nettopText, agyPids = new Set(), options = {}) {
  const empty = {
    externalSockets: [],
    loopbackSockets: [],
    liveExternal: { in: 0, out: 0, total: 0, count: 0, proxyCount: 0 },
    liveLoopback: { in: 0, out: 0, total: 0, count: 0 },
    byProcess: [],
  };
  if (typeof nettopText !== 'string' || !nettopText.trim()) return empty;

  const procLabels = options.procLabels instanceof Map ? options.procLabels : new Map();
  const envProxyPorts = options.proxyPorts instanceof Set ? options.proxyPorts : new Set();
  const proxyPids = options.proxyPids instanceof Set ? options.proxyPids : new Set();
  const useFallbackName = !(agyPids instanceof Set) || agyPids.size === 0;

  // 第一遍：按进程分组全部行，收集监听端口归属（区分 Antigravity 自身端口 vs 本地代理端口）
  const lines = nettopText.split(/\r?\n/);
  const entries = [];
  const agyListenPorts = new Set();
  const proxyListenPorts = new Set(envProxyPorts);
  let curProcName = '';
  let curPid = 0;

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    const parts = raw.split(',');
    const first = (parts[0] || '').trim();
    const iface = (parts[1] || '').trim();
    const state = (parts[2] || '').trim();

    // 进程汇总头行格式：<name>.<pid>,,,<bytes_in>,<bytes_out>,
    // 严格排除含 `<->` 或协议前缀的套接字行（防止无接口 IPv6 UDP 行误匹配为进程头）
    if (!iface && !state && !first.includes('<->') && !/^(?:tcp|udp|icmp)/i.test(first)) {
      const m = /^(.+)\.(\d+)$/.exec(first);
      if (m) {
        curProcName = m[1];
        curPid = Number(m[2]);
        continue;
      }
    }
    if (!curPid) continue;

    const isAgy = useFallbackName
      ? AGY_NETTOP_NAME_FALLBACK_RE.test(curProcName)
      : agyPids.has(curPid);

    if (state === 'Listen') {
      const { localPort } = parseSocketEndpoints(first);
      if (localPort) {
        if (isAgy) agyListenPorts.add(localPort);
        else if (proxyPids.has(curPid) || PROXY_PROC_NAME_RE.test(curProcName)) proxyListenPorts.add(localPort);
      }
      continue;
    }

    if (!isAgy) continue;
    const bytesIn = Math.max(0, Number(parts[3]) || 0);
    const bytesOut = Math.max(0, Number(parts[4]) || 0);
    if (!iface && bytesIn === 0 && bytesOut === 0) continue;

    entries.push({
      pid: curPid,
      procName: procLabels.get(curPid) || curProcName,
      socket: first,
      iface,
      state,
      in: bytesIn,
      out: bytesOut,
    });
  }

  const externalSockets = [];
  const rawLoopback = [];
  const procMap = new Map();

  for (const e of entries) {
    const ep = parseSocketEndpoints(e.socket);
    let isExternal = false;
    let viaProxy = false;

    if (e.iface && e.iface !== 'lo0') {
      if (!ep.remoteHost || !isLoopbackOrWildcardHost(ep.remoteHost)) {
        isExternal = true;
      }
    } else if (e.iface === 'lo0') {
      const isAgyIpc = (ep.localPort != null && agyListenPorts.has(ep.localPort))
        || (ep.remotePort != null && agyListenPorts.has(ep.remotePort));
      if (!isAgyIpc && ep.remotePort != null && proxyListenPorts.has(ep.remotePort)) {
        isExternal = true;
        viaProxy = true;
      }
    } else if (!e.iface) {
      // 未绑定特定接口的 UDP/QUIC 套接字：若远端为非回环/非通配公网地址且存在流量，按外网计入
      if (ep.remoteHost && !isLoopbackOrWildcardHost(ep.remoteHost) && (e.in > 0 || e.out > 0)) {
        isExternal = true;
      } else if (ep.remoteHost === '*' || !ep.remoteHost) {
        continue;
      }
    }

    const key = `${e.pid}|${e.socket}|${e.iface}`;
    const item = {
      key,
      pid: e.pid,
      procName: e.procName,
      iface: e.iface,
      viaProxy,
      in: e.in,
      out: e.out,
    };

    if (isExternal) {
      externalSockets.push(item);
      empty.liveExternal.in += e.in;
      empty.liveExternal.out += e.out;
      empty.liveExternal.count += 1;
      if (viaProxy) empty.liveExternal.proxyCount += 1;

      const pk = `${e.procName}#${e.pid}`;
      let pm = procMap.get(pk);
      if (!pm) {
        pm = { pid: e.pid, name: e.procName, in: 0, out: 0, total: 0, sockets: 0 };
        procMap.set(pk, pm);
      }
      pm.in += e.in;
      pm.out += e.out;
      pm.total = pm.in + pm.out;
      pm.sockets += 1;
    } else {
      rawLoopback.push({ item, ep });
    }
  }

  // 对本机 Antigravity 进程间回环 TCP 连接按无向端点对去重，避免客户端与服务端套接字各计一次（2× 虚高）
  const loGroups = new Map();
  for (const entry of rawLoopback) {
    const { ep, item } = entry;
    const pairKey = ep.left && ep.right
      ? (ep.left <= ep.right ? `${ep.left}|${ep.right}` : `${ep.right}|${ep.left}`)
      : item.key;
    let list = loGroups.get(pairKey);
    if (!list) {
      list = [];
      loGroups.set(pairKey, list);
    }
    list.push(entry);
  }

  const loopbackSockets = [];
  for (const list of loGroups.values()) {
    let chosen = list[0];
    if (list.length > 1) {
      // 稳定择取服务端套接字（或端口较小端），保证跨轮采样套接字键恒定
      const serverSide = list.find(
        (x) => x.ep.localPort != null && agyListenPorts.has(x.ep.localPort)
          && !(x.ep.remotePort != null && agyListenPorts.has(x.ep.remotePort)),
      );
      if (serverSide) {
        chosen = serverSide;
      } else {
        chosen = [...list].sort((a, b) => a.ep.left.localeCompare(b.ep.left))[0];
      }
    }
    loopbackSockets.push(chosen.item);
    empty.liveLoopback.in += chosen.item.in;
    empty.liveLoopback.out += chosen.item.out;
    empty.liveLoopback.count += 1;
  }

  empty.liveExternal.total = empty.liveExternal.in + empty.liveExternal.out;
  empty.liveLoopback.total = empty.liveLoopback.in + empty.liveLoopback.out;
  empty.externalSockets = externalSockets;
  empty.loopbackSockets = loopbackSockets;
  empty.byProcess = [...procMap.values()].sort((a, b) => b.total - a.total);
  return empty;
}

const UNATTRIBUTED_PROCESS_LABEL = '历史未分进程';
const NETWORK_RATE_STALE_MS = 15_000;

export function createEmptyTrafficLedger(now = Date.now()) {
  const date = localDateKey(now);
  return {
    version: 2,
    trackingSinceMs: now,
    lastSampleAtMs: 0,
    allTime: { in: 0, out: 0, total: 0 },
    today: { date, in: 0, out: 0, total: 0 },
    todayLoopback: { date, in: 0, out: 0, total: 0 },
    allTimeLoopback: { in: 0, out: 0, total: 0 },
    allTimeByProcess: {},
    todayByProcess: { date, map: {} },
    rates: { inBps: 0, outBps: 0, totalBps: 0 },
    lastSeenExternal: {},
    lastSeenLoopback: {},
  };
}

function cleanProcTotalsMap(obj, safeNum) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [name, v] of Object.entries(obj)) {
    if (!name || !v || typeof v !== 'object') continue;
    const i = safeNum(v.in);
    const o = safeNum(v.out);
    if (i > 0 || o > 0) {
      out[name] = { in: i, out: o, total: i + o };
    }
  }
  return out;
}

/**
 * 将分进程流量映射转为降序数组；若传入 `expectedBucket`，自动补齐升级前/历史未归属进程差额，
 * 确保分进程明细之和始终与卡片顶部总流量口径一致。
 */
export function sortProcessTrafficMap(mapObj, expectedBucket = null) {
  const items = [];
  let sumIn = 0;
  let sumOut = 0;
  if (mapObj && typeof mapObj === 'object') {
    for (const [name, v] of Object.entries(mapObj)) {
      if (!name || !v || typeof v !== 'object') continue;
      const inBytes = Math.max(0, Number(v.in) || 0);
      const outBytes = Math.max(0, Number(v.out) || 0);
      const total = Math.max(0, Number(v.total) || (inBytes + outBytes));
      if (total > 0) {
        items.push({ name, in: inBytes, out: outBytes, total });
        sumIn += inBytes;
        sumOut += outBytes;
      }
    }
  }
  if (expectedBucket && typeof expectedBucket === 'object') {
    const expIn = Math.max(0, Number(expectedBucket.in) || 0);
    const expOut = Math.max(0, Number(expectedBucket.out) || 0);
    const remIn = Math.max(0, expIn - sumIn);
    const remOut = Math.max(0, expOut - sumOut);
    const remTotal = remIn + remOut;
    if (remTotal > 0) {
      const existing = items.find((x) => x.name === UNATTRIBUTED_PROCESS_LABEL);
      if (existing) {
        existing.in += remIn;
        existing.out += remOut;
        existing.total = existing.in + existing.out;
        existing.unattributed = true;
      } else {
        items.push({
          name: UNATTRIBUTED_PROCESS_LABEL,
          in: remIn,
          out: remOut,
          total: remTotal,
          unattributed: true,
        });
      }
    }
  }
  return items.sort((a, b) => b.total - a.total);
}

/**
 * 归一化从磁盘读取的持久化网络流量账本（兼容 v1/旧 v2 自动平滑升级，补齐 `allTimeLoopback`）。
 */
export function normalizeTrafficLedger(raw, now = Date.now()) {
  const base = createEmptyTrafficLedger(now);
  if (!raw || typeof raw !== 'object') return base;
  const date = localDateKey(now);
  const safeNum = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);

  const allIn = safeNum(raw.allTime?.in);
  const allOut = safeNum(raw.allTime?.out);
  const sameToday = raw.today?.date === date;
  const tIn = sameToday ? safeNum(raw.today?.in) : 0;
  const tOut = sameToday ? safeNum(raw.today?.out) : 0;
  const sameLoToday = raw.todayLoopback?.date === date;
  const loIn = sameLoToday ? safeNum(raw.todayLoopback?.in) : 0;
  const loOut = sameLoToday ? safeNum(raw.todayLoopback?.out) : 0;
  const hasAllTimeLo = raw.allTimeLoopback && typeof raw.allTimeLoopback === 'object';
  const allLoIn = Math.max(loIn, safeNum(hasAllTimeLo ? raw.allTimeLoopback.in : raw.todayLoopback?.in));
  const allLoOut = Math.max(loOut, safeNum(hasAllTimeLo ? raw.allTimeLoopback.out : raw.todayLoopback?.out));
  const sameTodayProc = raw.todayByProcess?.date === date;

  const cleanSockets = (obj) => {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') {
        out[k] = { in: safeNum(v.in), out: safeNum(v.out) };
      }
    }
    return out;
  };

  return {
    version: 2,
    trackingSinceMs: safeNum(raw.trackingSinceMs) || now,
    lastSampleAtMs: safeNum(raw.lastSampleAtMs),
    allTime: { in: allIn, out: allOut, total: allIn + allOut },
    today: { date, in: tIn, out: tOut, total: tIn + tOut },
    todayLoopback: { date, in: loIn, out: loOut, total: loIn + loOut },
    allTimeLoopback: { in: allLoIn, out: allLoOut, total: allLoIn + allLoOut },
    allTimeByProcess: cleanProcTotalsMap(raw.allTimeByProcess, safeNum),
    todayByProcess: {
      date,
      map: sameTodayProc ? cleanProcTotalsMap(raw.todayByProcess?.map, safeNum) : {},
    },
    rates: { inBps: 0, outBps: 0, totalBps: 0 },
    lastSeenExternal: cleanSockets(raw.lastSeenExternal),
    lastSeenLoopback: cleanSockets(raw.lastSeenLoopback),
  };
}

function diffSocketMap(prevMap, sockets) {
  let deltaIn = 0;
  let deltaOut = 0;
  const nextMap = {};
  const deltaByProcess = {};
  for (const s of sockets) {
    const prev = prevMap[s.key];
    let dIn = 0;
    let dOut = 0;
    if (!prev) {
      dIn = s.in;
      dOut = s.out;
    } else {
      // 同一元组计数回落（说明内核关闭并复用了本地临时端口）→ 按新连接计入
      dIn = s.in >= prev.in ? (s.in - prev.in) : s.in;
      dOut = s.out >= prev.out ? (s.out - prev.out) : s.out;
    }
    deltaIn += dIn;
    deltaOut += dOut;
    if (dIn > 0 || dOut > 0) {
      const pName = s.procName || 'Antigravity';
      if (!deltaByProcess[pName]) deltaByProcess[pName] = { in: 0, out: 0 };
      deltaByProcess[pName].in += dIn;
      deltaByProcess[pName].out += dOut;
    }
    nextMap[s.key] = { in: s.in, out: s.out };
  }
  return { deltaIn, deltaOut, nextMap, deltaByProcess };
}

function mergeProcessTotals(baseMap, deltaMap) {
  const out = {};
  for (const [k, v] of Object.entries(baseMap || {})) {
    out[k] = { in: v.in, out: v.out, total: v.in + v.out };
  }
  for (const [k, d] of Object.entries(deltaMap || {})) {
    if (!out[k]) out[k] = { in: 0, out: 0, total: 0 };
    out[k].in += d.in;
    out[k].out += d.out;
    out[k].total = out[k].in + out[k].out;
  }
  return out;
}

/**
 * 以新一次 `parseNettopSockets` 采样更新持久化账本：
 * - 单调累加各套接字字节增量，连接关闭不掉数、服务热重载不重复计算。
 * - 自动跨日滚动 `today` 桶与分进程当日明细，保留 `allTime` 历史累计与 `allTimeLoopback`。
 * - 当采样间隔合理（0.4s ~ 60s）时计算实时上传/下载速率（B/s）。
 */
export function updateTrafficLedger(prevLedger, sample, now = Date.now()) {
  const prev = normalizeTrafficLedger(prevLedger, now);
  if (!sample) return { ledger: prev, deltaIn: 0, deltaOut: 0 };

  const ext = diffSocketMap(prev.lastSeenExternal, sample.externalSockets || []);
  const lo = diffSocketMap(prev.lastSeenLoopback, sample.loopbackSockets || []);
  const date = localDateKey(now);

  const todayIn = (prev.today.date === date ? prev.today.in : 0) + ext.deltaIn;
  const todayOut = (prev.today.date === date ? prev.today.out : 0) + ext.deltaOut;
  const loIn = (prev.todayLoopback.date === date ? prev.todayLoopback.in : 0) + lo.deltaIn;
  const loOut = (prev.todayLoopback.date === date ? prev.todayLoopback.out : 0) + lo.deltaOut;
  const allLoIn = prev.allTimeLoopback.in + lo.deltaIn;
  const allLoOut = prev.allTimeLoopback.out + lo.deltaOut;
  const allIn = prev.allTime.in + ext.deltaIn;
  const allOut = prev.allTime.out + ext.deltaOut;
  const allTimeByProcess = mergeProcessTotals(prev.allTimeByProcess, ext.deltaByProcess);
  const todayBaseProc = prev.todayByProcess.date === date ? prev.todayByProcess.map : {};
  const todayByProcess = {
    date,
    map: mergeProcessTotals(todayBaseProc, ext.deltaByProcess),
  };

  let inBps = 0;
  let outBps = 0;
  const hadPriorSample = prev.lastSampleAtMs > 0;
  const dtSec = hadPriorSample ? (now - prev.lastSampleAtMs) / 1000 : 0;
  if (hadPriorSample && dtSec >= 0.4 && dtSec <= 60) {
    inBps = Math.round(ext.deltaIn / dtSec);
    outBps = Math.round(ext.deltaOut / dtSec);
  }

  return {
    deltaIn: ext.deltaIn,
    deltaOut: ext.deltaOut,
    ledger: {
      version: 2,
      trackingSinceMs: prev.trackingSinceMs || now,
      lastSampleAtMs: now,
      allTime: { in: allIn, out: allOut, total: allIn + allOut },
      today: { date, in: todayIn, out: todayOut, total: todayIn + todayOut },
      todayLoopback: { date, in: loIn, out: loOut, total: loIn + loOut },
      allTimeLoopback: { in: allLoIn, out: allLoOut, total: allLoIn + allLoOut },
      allTimeByProcess,
      todayByProcess,
      rates: { inBps, outBps, totalBps: inBps + outBps },
      lastSeenExternal: ext.nextMap,
      lastSeenLoopback: lo.nextMap,
    },
  };
}

/**
 * 清零累计外网流量计数，同时保留（或以最新采样刷新）当前打开连接的高水位基线，
 * 避免重置后下一轮采样立刻把旧连接的历史字节数重新加回来。
 */
export function resetTrafficLedger(prevLedger, now = Date.now(), freshSample = null) {
  const prev = normalizeTrafficLedger(prevLedger, now);
  const date = localDateKey(now);
  let lastSeenExternal = { ...prev.lastSeenExternal };
  let lastSeenLoopback = { ...prev.lastSeenLoopback };
  if (freshSample) {
    lastSeenExternal = {};
    for (const s of freshSample.externalSockets || []) {
      lastSeenExternal[s.key] = { in: s.in, out: s.out };
    }
    lastSeenLoopback = {};
    for (const s of freshSample.loopbackSockets || []) {
      lastSeenLoopback[s.key] = { in: s.in, out: s.out };
    }
  }
  return {
    version: 2,
    trackingSinceMs: now,
    lastSampleAtMs: freshSample ? now : (prev.lastSampleAtMs || now),
    allTime: { in: 0, out: 0, total: 0 },
    today: { date, in: 0, out: 0, total: 0 },
    todayLoopback: { date, in: 0, out: 0, total: 0 },
    allTimeLoopback: { in: 0, out: 0, total: 0 },
    allTimeByProcess: {},
    todayByProcess: { date, map: {} },
    rates: { inBps: 0, outBps: 0, totalBps: 0 },
    lastSeenExternal,
    lastSeenLoopback,
  };
}

/**
 * 构建对外返回的网络流量快照：
 * - 当最近一次成功采样已过期（默认 >15s，如 `nettop` 超时或机器休眠）时将实时速率衰减归零；
 * - 对今日与历史分进程明细自动补齐升级前未归属差额，保证分进程之和与总流量一致。
 */
export function buildNetworkSnapshot(ledger, sample = null, now = Date.now(), options = {}) {
  if (options.available === false) {
    return {
      available: false,
      reason: options.reason || '当前系统不支持 macOS 原生 nettop 进程级流量统计',
    };
  }
  const staleMs = Number.isFinite(options.rateStaleMs) ? options.rateStaleMs : NETWORK_RATE_STALE_MS;
  const normalized = normalizeTrafficLedger(ledger, now);
  const ageMs = normalized.lastSampleAtMs > 0 ? (now - normalized.lastSampleAtMs) : Infinity;
  const isRateFresh = ageMs >= -5_000 && ageMs <= staleMs;
  const rawRates = isRateFresh && ledger?.rates && typeof ledger.rates === 'object' ? ledger.rates : null;
  const inBps = rawRates && Number.isFinite(Number(rawRates.inBps)) && Number(rawRates.inBps) > 0
    ? Math.round(Number(rawRates.inBps))
    : 0;
  const outBps = rawRates && Number.isFinite(Number(rawRates.outBps)) && Number(rawRates.outBps) > 0
    ? Math.round(Number(rawRates.outBps))
    : 0;

  return {
    available: true,
    sampledAtMs: normalized.lastSampleAtMs || now,
    trackingSinceMs: normalized.trackingSinceMs,
    todayDate: normalized.today.date,
    rates: { inBps, outBps, totalBps: inBps + outBps },
    liveExternal: sample?.liveExternal || { in: 0, out: 0, total: 0, count: 0, proxyCount: 0 },
    liveLoopback: sample?.liveLoopback || { in: 0, out: 0, total: 0, count: 0 },
    today: normalized.today,
    todayLoopback: normalized.todayLoopback,
    allTime: normalized.allTime,
    allTimeLoopback: normalized.allTimeLoopback,
    byProcess: sample?.byProcess || [],
    todayByProcess: sortProcessTrafficMap(normalized.todayByProcess?.map, normalized.today),
    allTimeByProcess: sortProcessTrafficMap(normalized.allTimeByProcess, normalized.allTime),
  };
}

// ---------------------------------------------------------------------------
// `GetUserStatus` 账号模型配额解析
// ---------------------------------------------------------------------------

function normalizeModelMatchKey(name) {
  return String(name || '')
    .replace(/（高推理）/g, ' (high)')
    .replace(/（极高推理）/g, ' (xhigh)')
    .replace(/（中推理）/g, ' (medium)')
    .replace(/（低推理）/g, ' (low)')
    .replace(/\s*\(/g, ' (')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeModelSlug(name) {
  return normalizeModelMatchKey(name)
    .replace(/[()]/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugStartsWithToken(haystack, prefix) {
  if (!haystack || !prefix) return false;
  return haystack === prefix || haystack.startsWith(`${prefix} `);
}

function summarizeBucketLabel(labels) {
  if (!labels.length) return '模型配额';
  const families = [];
  const seen = new Set();
  for (const raw of labels) {
    const fam = String(raw || '')
      .replace(/\s*\([^)]*\)\s*/g, '')
      .replace(/\s+(?:High|Medium|Low|XHigh|Max)$/i, '')
      .trim();
    if (!fam) continue;
    // 提炼大类名称，避免把 20 个同族变体拼成超长标题
    let shortFam = fam;
    if (/^Gemini\s+4/i.test(fam)) shortFam = 'Gemini 4';
    else if (/^Gemini\s+3/i.test(fam)) shortFam = 'Gemini 3';
    else if (/^Orchestrator/i.test(fam)) shortFam = 'Orchestrator';
    else if (/^Claude/i.test(fam)) shortFam = 'Claude';
    else if (/^GPT/i.test(fam)) shortFam = 'GPT';
    if (!seen.has(shortFam)) {
      seen.add(shortFam);
      families.push(shortFam);
    }
  }
  if (!families.length) return labels[0];
  return families.slice(0, 3).join(' / ') + (families.length > 3 ? ' 等' : '');
}

/**
 * 解析 `GetUserStatus` 返回体中的套餐信息、积分额度与按桶去重后的模型剩余配额。
 * `currentModelName` 支持传入单个模型名或候选名称数组（如显示名、responseModel、本地化名）。
 */
export function parseUserStatusQuota(rawJson, currentModelName = '') {
  const us = rawJson?.userStatus;
  if (!us || typeof us !== 'object') return null;

  const planInfo = us.planStatus?.planInfo || us.planInfo || {};
  const planStatus = us.planStatus || {};
  const tierName = typeof us.userTier?.name === 'string' ? us.userTier.name.trim() : '';
  const planName = tierName || (typeof planInfo.planName === 'string' ? planInfo.planName.trim() : '');

  const numOrNull = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const credits = {
    availablePrompt: numOrNull(planStatus.availablePromptCredits),
    availableFlow: numOrNull(planStatus.availableFlowCredits),
    availableFlex: numOrNull(planStatus.availableFlexCredits),
    usedPrompt: numOrNull(planStatus.usedPromptCredits ?? us.userUsedPromptCredits),
    usedFlow: numOrNull(planStatus.usedFlowCredits ?? us.userUsedFlowCredits),
    monthlyPrompt: numOrNull(planInfo.monthlyPromptCredits),
    monthlyFlow: numOrNull(planInfo.monthlyFlowCredits),
  };
  const hasCredits = Object.values(credits).some((v) => v != null);

  const configs = Array.isArray(us.cascadeModelConfigData?.clientModelConfigs)
    ? us.cascadeModelConfigData.clientModelConfigs
    : [];

  const buckets = new Map();
  let currentModelQuota = null;
  let currentModelExact = false;
  const rawTargets = Array.isArray(currentModelName) ? currentModelName : [currentModelName];
  const targets = rawTargets
    .map((raw) => {
      const norm = normalizeModelMatchKey(raw);
      if (!norm) return null;
      return {
        norm,
        slug: normalizeModelSlug(raw),
        base: norm.replace(/\s*\([^)]*\)\s*/g, '').trim(),
        rawLower: String(raw || '').trim().toLowerCase(),
      };
    })
    .filter(Boolean);

  for (const cfg of configs) {
    const cfgLabel = typeof cfg?.label === 'string' ? cfg.label.trim() : '';
    const cfgModelId = typeof cfg?.modelId === 'string' ? cfg.modelId.trim() : '';
    const label = cfgLabel || cfgModelId;
    const qi = cfg?.quotaInfo;
    if (!label || !qi || typeof qi !== 'object') continue;
    const resetTime = typeof qi.resetTime === 'string' ? qi.resetTime : '';
    // Proto3 JSON 序列化会省略默认零值（remainingFraction === 0），当存在 resetTime 时按 0% 耗尽处理
    const hasFraction = qi.remainingFraction != null && Number.isFinite(Number(qi.remainingFraction));
    if (!hasFraction && !resetTime) continue;

    const remainingFraction = hasFraction ? Math.min(1, Math.max(0, Number(qi.remainingFraction))) : 0;
    const remainingPercent = Math.round(remainingFraction * 1000) / 10;
    const resetAtMs = resetTime ? Date.parse(resetTime) : null;

    const bucketKey = `${remainingFraction.toFixed(4)}|${resetTime}`;
    let b = buckets.get(bucketKey);
    if (!b) {
      b = {
        labels: [],
        remainingFraction,
        remainingPercent,
        resetTime,
        resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : null,
      };
      buckets.set(bucketKey, b);
    }
    b.labels.push(label);

    if (targets.length && !currentModelExact) {
      const cfgNorm = normalizeModelMatchKey(label);
      const cfgSlug = normalizeModelSlug(label);
      const cfgModelIdRaw = cfgModelId.toLowerCase();
      const cfgModelIdSlug = normalizeModelSlug(cfgModelId);
      const cfgModelAlias = String(cfg?.modelOrAlias?.model || '').trim().toLowerCase();
      const cfgModelAliasSlug = normalizeModelSlug(cfg?.modelOrAlias?.model || '');

      let isExact = false;
      let isPrefix = false;
      for (const t of targets) {
        if (
          cfgNorm === t.norm
          || (t.slug && cfgSlug === t.slug)
          || (cfgModelIdRaw && cfgModelIdRaw === t.rawLower)
          || (t.slug && cfgModelIdSlug && cfgModelIdSlug === t.slug)
          || (cfgModelAlias && cfgModelAlias === t.rawLower)
          || (t.slug && cfgModelAliasSlug && cfgModelAliasSlug === t.slug)
        ) {
          isExact = true;
          break;
        }
        if (
          (t.base && (cfgNorm === t.base || cfgNorm.startsWith(`${t.base} `) || cfgNorm.startsWith(`${t.base}(`)))
          || (t.slug && (slugStartsWithToken(cfgSlug, t.slug) || slugStartsWithToken(t.slug, cfgSlug)))
          || (cfgModelIdRaw && t.rawLower && (cfgModelIdRaw.startsWith(`${t.rawLower}-`) || cfgModelIdRaw.startsWith(`${t.rawLower}_`)))
          || (t.slug && cfgModelIdSlug && (slugStartsWithToken(cfgModelIdSlug, t.slug) || slugStartsWithToken(t.slug, cfgModelIdSlug)))
        ) {
          isPrefix = true;
        }
      }

      if (isExact || (!currentModelQuota && isPrefix)) {
        currentModelQuota = {
          label,
          remainingFraction,
          remainingPercent,
          resetTime,
          resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : null,
        };
        if (isExact) currentModelExact = true;
      }
    }
  }

  const groups = [...buckets.values()]
    .map((b) => ({
      label: summarizeBucketLabel(b.labels),
      modelsCount: b.labels.length,
      remainingFraction: b.remainingFraction,
      remainingPercent: b.remainingPercent,
      resetTime: b.resetTime,
      resetAtMs: b.resetAtMs,
    }))
    .sort((a, b) => a.remainingFraction - b.remainingFraction);

  if (!planName && !hasCredits && !groups.length) return null;

  return {
    planName,
    credits: hasCredits ? credits : null,
    groups,
    currentModelQuota,
  };
}
