/**
 * Antigravity 会话监控前端控制器（`sidecars/session_monitor/app.js`）。
 *
 * 采用严格三层信息主次结构：
 * - 一级重心：当前任务状态英雄卡 + 三栏核心指标（速度 / 耗时 / 上下文）
 * - 二级进展：阶段进度（100% 自动收起、无清单自动隐藏）+ 并发子代理（0 个自动隐藏）
 * - 三级背景：其他活跃任务扁平分隔列表（已结束会话默认折叠降噪）
 */
(() => {
  const ACTIVE_POLL_MS = 1200;
  const IDLE_POLL_MS = 2500;
  const $ = (id) => document.getElementById(id);

  const urlParams = new URLSearchParams(window.location.search);
  const hostConvId = () => window.sidecar?.conversationId || urlParams.get('conversationId') || '';

  const state = {
    overrideConvId: '',
    lastHostConvId: hostConvId(),
    deletedHostConvId: '',
    hostWorkspaceName: '',
    etag: '',
    uiBuildKey: '',
    serverClockSkewMs: 0,
    snap: null,
    settings: null,
    tab: 'overview',
    tlFilter: 'all',
    netScope: 'today',
    guScope: 'all',
    drawerSettingsOpen: false,
    nudgeOpen: false,
    prevHealthState: '',
    autoExpandedAlertKey: '',
    msExpandedOverride: null, // null = 自动（<100% 展开，100% 收起），boolean = 用户手动切换
    lastMsConvKey: '',
    idleSessionsExpanded: false,
    compactingConvId: '',
    compactingBaselineCount: 0,
    compactingBaselineReverts: 0,
    compactingMaxSteps: 0,
    compactingSawRunning: false,
    compactingSubmittedAtMs: 0,
    compactingUntilMs: 0,
  };

  if (window.sidecar?.onWorkspaceChange) {
    window.sidecar.onWorkspaceChange((uris) => {
      const first = Array.isArray(uris) && uris[0] ? String(uris[0]) : '';
      const name = first ? decodeURIComponent(first.replace(/\/+$/, '').split('/').pop() || '') : '';
      if (name !== state.hostWorkspaceName) {
        state.hostWorkspaceName = name;
        if (state.snap) renderAll();
      }
    });
  }

  // ---------- 自动同步宿主亮暗主题 ----------
  function syncThemeScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #0f1117)';
    document.documentElement.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    const nums = (computed.match(/[\d.]+/g) || []).map(Number);
    if (nums.length >= 3) {
      const scale = computed.startsWith('color(') ? 1 : 255;
      const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      document.documentElement.dataset.theme = lum < 0.52 ? 'dark' : 'light';
    }
  }
  syncThemeScheme();
  new MutationObserver(syncThemeScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- 格式化辅助函数 ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function fmtClockTimer(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }

  function fmtShortDur(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  }

  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(2)}亿`;
    if (v >= 10_000) return `${(v / 10_000).toFixed(1)}万`;
    return v.toLocaleString();
  }

  function fmtBytes(bytes) {
    const b = Math.max(0, Number(bytes) || 0);
    if (b < 1024) return `${Math.round(b)} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(b >= 100 * 1024 ? 0 : 1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(b >= 100 * 1024 * 1024 ? 1 : 2)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function fmtByteRate(bps) {
    const v = Math.max(0, Number(bps) || 0);
    if (v < 1) return '0 B/s';
    if (v < 1024) return `${Math.round(v)} B/s`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(v >= 100 * 1024 ? 0 : 1)} KB/s`;
    return `${(v / (1024 * 1024)).toFixed(2)} MB/s`;
  }

  function fmtByteRateCompact(bps) {
    const v = Math.max(0, Number(bps) || 0);
    if (v < 1) return '0B/s';
    if (v < 1024) return `${Math.round(v)}B/s`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(v >= 100 * 1024 ? 0 : 1)}K/s`;
    return `${(v / (1024 * 1024)).toFixed(1)}M/s`;
  }

  function fmtMsShort(ms) {
    const v = Number(ms);
    if (!Number.isFinite(v) || v < 0) return '—';
    if (v < 1000) return `${Math.round(v)}ms`;
    if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
    return fmtShortDur(v / 1000);
  }

  function fmtDateTimeShort(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const d = new Date(ms);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${m}-${day} ${hh}:${mm}`;
  }

  function fmtResetCountdown(resetAtMs, nowMs) {
    if (!Number.isFinite(resetAtMs)) return '';
    const diffSec = Math.max(0, Math.round((resetAtMs - nowMs) / 1000));
    if (diffSec < 60) return '即将重置';
    if (diffSec >= 86400) {
      const days = Math.floor(diffSec / 86400);
      const hrs = Math.floor((diffSec % 86400) / 3600);
      return `${days}天${hrs > 0 ? `${hrs}h` : ''}后重置`;
    }
    return `${fmtShortDur(diffSec)}后重置`;
  }

  function cacheToneClass(rate) {
    if (rate == null || !Number.isFinite(Number(rate))) return '';
    if (rate >= 85) return 'is-cache-high';
    if (rate >= 60) return 'is-cache-mid';
    return 'is-cache-low';
  }

  function fmtTimeOfDay(ms) {
    if (!Number.isFinite(ms)) return '';
    return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function dotClassFor(healthState, severity) {
    if (healthState === 'THINKING') return 'st-thinking';
    return `st-${severity || 'idle'}`;
  }

  function cardClassFor(healthState, severity) {
    if (healthState === 'THINKING') return 'sev-thinking';
    return `sev-${severity || 'idle'}`;
  }

  function formatTpsTooltip(ts) {
    if (!ts || (ts.latestTps == null && ts.decodeTps == null)) return '等待首轮模型生成完成后计算生成速度';
    return [
      ts.latestTps != null
        ? `最新一轮：${ts.latestTps.toFixed(1)} t/s${ts.latestOutTokens ? `（${ts.latestOutTokens.toLocaleString()} t / ${ts.latestGenSec ?? '?'}s）` : ''}`
        : '',
      ts.avgTps != null ? `任务均值：${ts.avgTps.toFixed(1)} t/s` : '',
      ts.peakTps != null ? `历史峰值：${ts.peakTps.toFixed(1)} t/s` : '',
      ts.latestDecodeTps != null ? `最新流式解码：${ts.latestDecodeTps.toFixed(1)} t/s` : '',
      ts.decodeTps != null ? `均值流式解码：${ts.decodeTps.toFixed(1)} t/s` : '',
      ts.activeSubagentTpsSum ? `并发子代理合算：${ts.activeSubagentTpsSum.toFixed(1)} t/s` : '',
    ].filter(Boolean).join('\n');
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2000);
  }

  async function apiGet(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`请求失败（${res.status}）`);
    return res.json();
  }

  async function apiPost(path, body) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error(`请求失败（${res.status}）`);
    return res.json();
  }

  async function copyTextRobust(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // 继续走降级通道
      }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) return true;
    } catch {
      // 继续走原生剪贴板通道
    }
    try {
      const res = await apiPost('/api/clipboard', { text });
      return Boolean(res?.ok);
    } catch {
      return false;
    }
  }

  function activeTargetConvId() {
    if (state.overrideConvId) return state.overrideConvId;
    const hId = hostConvId();
    if (hId && hId === state.deletedHostConvId) return '';
    return hId;
  }

  const GENERATING_STATES = new Set(['THINKING', 'THINKING_DEEP']);
  const RUNNING_STATES = new Set(['THINKING', 'THINKING_DEEP', 'TOOL_ACTIVE', 'RETRYING', 'SUBAGENT_RUNNING']);
  const LIVE_STATES = new Set(['THINKING', 'THINKING_DEEP', 'TOOL_ACTIVE', 'RETRYING', 'SUBAGENT_RUNNING', 'WAITING_USER', 'STUCK_SUSPECTED']);
  const INTERVENE_STATES = new Set(['STUCK_SUSPECTED', 'ERROR_STOPPED', 'WAITING_USER', 'RETRYING']);

  // ---------- 视图渲染 ----------
  function renderAll() {
    const snap = state.snap;
    if (!snap) return;

    const cur = snap.current || {};
    const h = cur.health || {};
    const gl = snap.global || { activeCount: 0, attentionCount: 0, sessions: [] };
    const isLive = LIVE_STATES.has(h.state);
    const isGenerating = GENERATING_STATES.has(h.state);
    const isRunning = RUNNING_STATES.has(h.state);

    // 1. 顶栏信息
    const ownId = hostConvId();
    const effectiveOwnId = ownId && ownId === state.deletedHostConvId ? '' : ownId;
    const showingOther = Boolean(state.overrideConvId && state.overrideConvId !== effectiveOwnId);
    $('btn-back-own').classList.toggle('hidden', !showingOther);

    const effectiveWsName = cur.workspaceName || (!showingOther ? state.hostWorkspaceName : '');
    if (effectiveWsName) {
      $('ws-tag').textContent = effectiveWsName;
      $('ws-tag').title = effectiveWsName;
      $('ws-tag').classList.remove('hidden');
    } else {
      $('ws-tag').textContent = '';
      $('ws-tag').title = '';
      $('ws-tag').classList.add('hidden');
    }

    $('conv-title').textContent = cur.conversationId
      ? (cur.title || `会话 ${cur.conversationId.slice(0, 8)}`)
      : '未关联会话';
    $('conv-title').title = cur.conversationId ? `会话编号：${cur.conversationId}` : '';

    // 2. 一级焦点：状态英雄卡
    const dotCls = dotClassFor(h.state, h.severity);
    $('hero-card').className = `hero-card ${cardClassFor(h.state, h.severity)}`;
    $('hero-dot').className = `pulse-dot ${dotCls}`;
    $('hero-state-title').textContent = h.badge || '空闲待命';

    if (h.process && Number.isFinite(h.process.cpu)) {
      $('hero-cpu').textContent = `CPU ${h.process.cpu.toFixed(1)}%`;
      $('hero-cpu').classList.remove('hidden');
    } else {
      $('hero-cpu').classList.add('hidden');
    }

    $('hero-headline').textContent = h.headline || '等待发送任务指令';
    if (h.detail) {
      $('hero-detail').textContent = h.detail;
      $('hero-detail').classList.remove('hidden');
    } else {
      $('hero-detail').classList.add('hidden');
    }

    // 三栏核心遥测指标
    const sp = cur.tokenSpeed || {};
    const tpsEl = $('metric-tps');
    const tpsSubEl = $('metric-tps-sub');
    $('metric-speed-box').title = formatTpsTooltip(sp);

    if (isGenerating && sp.turnLatestTps == null) {
      tpsEl.textContent = '测速中…';
      tpsEl.classList.add('is-live-speed');
      tpsSubEl.textContent = sp.latestTps != null
        ? `上轮 ${sp.latestTps.toFixed(1)} t/s`
        : '等待首轮落盘';
    } else if (sp.turnLatestTps != null || sp.latestTps != null) {
      const displayTps = (isRunning && sp.turnLatestTps != null) ? sp.turnLatestTps : sp.latestTps;
      tpsEl.textContent = `${displayTps.toFixed(1)} t/s`;
      tpsEl.classList.toggle('is-live-speed', isRunning);
      if (isRunning && sp.activeSubagentTpsSum) {
        tpsSubEl.textContent = `子代理 ${sp.activeSubagentTpsSum.toFixed(1)} t/s`;
      } else if (sp.avgTps != null) {
        tpsSubEl.textContent = `均值 ${sp.avgTps.toFixed(1)} t/s`;
      } else {
        tpsSubEl.textContent = `峰值 ${(sp.peakTps ?? displayTps).toFixed(1)} t/s`;
      }
    } else if (h.state === 'SUBAGENT_RUNNING' && sp.activeSubagentTpsSum) {
      tpsEl.textContent = `${sp.activeSubagentTpsSum.toFixed(1)} t/s`;
      tpsEl.classList.add('is-live-speed');
      tpsSubEl.textContent = '并发子代理合算';
    } else {
      tpsEl.textContent = '—';
      tpsEl.classList.remove('is-live-speed');
      tpsSubEl.textContent = isRunning ? '执行操作中' : '暂无生成';
    }

    const turnRoundNum = Number(h.invocationNum) || 0;
    const totalRounds = Number(cur.totalRounds) || 0;
    const compactCount = cur.compactCount || 0;
    if (turnRoundNum > 0 && totalRounds > turnRoundNum) {
      $('metric-steps').textContent = `本轮 ${turnRoundNum}/${totalRounds} 轮 · ${cur.stepCount || 0} 步`;
    } else if ((turnRoundNum || totalRounds) > 0) {
      $('metric-steps').textContent = `${turnRoundNum || totalRounds} 轮 · ${cur.stepCount || 0} 步`;
    } else {
      $('metric-steps').textContent = `${cur.stepCount || 0} 步`;
    }
    $('metric-steps-box').title = compactCount > 0
      ? `累计 ${totalRounds} 轮 / ${cur.stepCount || 0} 步 · 已压缩 ${compactCount} 次`
      : `累计 ${totalRounds} 轮 / ${cur.stepCount || 0} 步`;

    const tok = cur.tokens || {};
    const sm = cur.metrics || null;
    const net = snap.network || null;
    const quota = snap.quota || null;

    $('metric-ctx').textContent = fmtTokens(tok.currentContext || 0);
    $('metric-out').textContent = tok.contextUsagePercent != null
      ? `${tok.contextUsagePercent.toFixed(0)}% · 出${fmtTokens(tok.grandTotalOutput || tok.output || 0)}`
      : `输出 ${fmtTokens(tok.grandTotalOutput || tok.output || 0)}`;
    $('metric-tok-box').title = [
      `当前上下文窗口占用：${(tok.currentContext || 0).toLocaleString()} t${tok.maxContextTokens ? ` / ${tok.maxContextTokens.toLocaleString()} t（${tok.contextUsagePercent ?? 0}%）` : '（~26万 t 触发自动压缩）'}`,
      `未命中输入：${(tok.input || 0).toLocaleString()} t`,
      `缓存命中：${(tok.cache || 0).toLocaleString()} t`,
      tok.cacheWrite ? `缓存写入：${tok.cacheWrite.toLocaleString()} t` : '',
      `主会话输出：${(tok.output || 0).toLocaleString()} t${sm?.tokens?.hasThinkingBreakdown ? `（思考 ${(tok.thinkingOutput || 0).toLocaleString()} / 正文 ${(tok.responseOutput || 0).toLocaleString()}）` : ''}`,
      tok.subagentOutput ? `子代理输出：${tok.subagentOutput.toLocaleString()} t` : '',
      sm?.tokens?.latestPromptBytes ? `最新单次 Prompt 载荷：${fmtBytes(sm.tokens.latestPromptBytes)}` : '',
    ].filter(Boolean).join('\n');

    // 第二行核心遥测：缓存命中率 / AGY 服务端流量 / 累计词元与首字延迟
    const hitRate = sm?.cache?.grandHitRate ?? sm?.cache?.hitRate ?? tok.grandCacheHitRate ?? tok.cacheHitRate ?? null;
    const mainOnlyHitRate = sm?.cache?.hitRate ?? tok.cacheHitRate ?? null;
    const latestHitRate = sm?.cache?.latestHitRate ?? tok.latestCacheHitRate ?? null;
    const hasSubTokens = (sm?.tokens?.subagentTotalTokens || 0) > 0;
    const cacheValEl = $('metric-cache');
    cacheValEl.className = `metric-val tabular ${cacheToneClass(hitRate)}`;
    cacheValEl.textContent = hitRate != null ? `${hitRate.toFixed(1)}%` : '—';
    $('metric-cache-sub').textContent = latestHitRate != null
      ? `本轮 ${latestHitRate.toFixed(1)}%`
      : (hitRate != null ? `命中 ${fmtTokens(sm?.cache?.savedTokens ?? tok.cache ?? 0)}` : '暂无数据');
    $('metric-cache-box').title = [
      hitRate != null ? `本会话累计缓存命中率${hasSubTokens ? '（含子代理）' : ''}：${hitRate.toFixed(1)}%` : '等待首次模型返回统计缓存命中率',
      hasSubTokens && mainOnlyHitRate != null ? `主会话单独命中率：${mainOnlyHitRate.toFixed(1)}%` : '',
      latestHitRate != null ? `最新一轮缓存命中率：${latestHitRate.toFixed(1)}%` : '',
      `缓存命中读取：${(sm?.cache?.savedTokens ?? tok.cache ?? 0).toLocaleString()} t`,
      `未命中新输入：${((tok.input || 0) + (tok.subagentInput || 0)).toLocaleString()} t`,
      (sm?.cache?.cacheWriteTokens || tok.cacheWrite) ? `缓存写入：${(sm?.cache?.cacheWriteTokens || tok.cacheWrite).toLocaleString()} t` : '',
      '点击查看完整流量与缓存明细',
    ].filter(Boolean).join('\n');

    const netValEl = $('metric-net');
    const netSubEl = $('metric-net-sub');
    if (net?.available) {
      const todayBucket = net.today || { in: 0, out: 0, total: 0 };
      const todayTotal = todayBucket.total || 0;
      const allTotal = net.allTime?.total || 0;
      // 始终以 AGY 今日累计通信流量作为主值，清零或跨日后立即归零，不回退到旧活跃连接字节数
      netValEl.textContent = fmtBytes(todayTotal);
      const totalRate = net.rates?.totalBps || 0;
      netValEl.classList.toggle('is-live-speed', totalRate >= 1024);
      if (totalRate >= 512) {
        netSubEl.textContent = `↑${fmtByteRateCompact(net.rates.outBps)} ↓${fmtByteRateCompact(net.rates.inBps)}`;
      } else if (allTotal > todayTotal) {
        netSubEl.textContent = `累计 ${fmtBytes(allTotal)}`;
      } else {
        netSubEl.textContent = `↑${fmtBytes(todayBucket.out || 0)} ↓${fmtBytes(todayBucket.in || 0)}`;
      }
      $('metric-net-box').title = [
        '仅统计本机 Antigravity（AGY）自身进程与远端服务器通信流量（不含其他软件与本地回环）',
        `AGY 今日累计：${fmtBytes(todayTotal)}（上传 ${fmtBytes(todayBucket.out || 0)} / 下载 ${fmtBytes(todayBucket.in || 0)}）`,
        `AGY 历史累计：${fmtBytes(allTotal)}（上传 ${fmtBytes(net.allTime?.out || 0)} / 下载 ${fmtBytes(net.allTime?.in || 0)}）`,
        `AGY 当前活跃连接：${net.liveExternal?.count || 0} 条（${fmtBytes(net.liveExternal?.total || 0)}）`,
        `已剔除本地 IPC 回环：当前 ${fmtBytes(net.liveLoopback?.total || 0)} / 今日 ${fmtBytes(net.todayLoopback?.total || 0)}`,
        '点击查看完整流量统计页签',
      ].join('\n');
    } else {
      netValEl.textContent = '—';
      netValEl.classList.remove('is-live-speed');
      netSubEl.textContent = '仅 macOS';
      $('metric-net-box').title = net?.reason || '点击查看词元流量与接口统计';
    }

    const grandTotalTok = tok.grandTotalTokens || tok.total || 0;
    $('metric-total-tok').textContent = fmtTokens(grandTotalTok);
    const latestTtft = sm?.latency?.latestTtftMs ?? null;
    const avgTtft = sm?.latency?.avgTtftMs ?? null;
    const curQuota = quota?.currentModelQuota || null;
    if (latestTtft != null) {
      $('metric-total-sub').textContent = `首字 ${fmtMsShort(latestTtft)}`;
    } else if (curQuota) {
      $('metric-total-sub').textContent = `配额 ${curQuota.remainingPercent.toFixed(0)}%`;
    } else {
      $('metric-total-sub').textContent = sm?.apiCalls ? `${sm.apiCalls} 次调用` : '点击看明细';
    }
    $('metric-total-box').title = [
      `本会话累计词元（含子代理）：${grandTotalTok.toLocaleString()} t`,
      sm?.apiCalls ? `API 调用：${sm.apiCalls} 次${sm.subagentApiCalls ? `（含子代理 +${sm.subagentApiCalls}）` : ''}` : '',
      latestTtft != null ? `首字延迟 TTFT：最新 ${fmtMsShort(latestTtft)}${avgTtft != null ? ` / 均值 ${fmtMsShort(avgTtft)}` : ''}` : '',
      sm?.quality?.retries ? `接口重试：${sm.quality.retries} 次` : '',
      curQuota ? `当前模型配额剩余：${curQuota.remainingPercent.toFixed(1)}%` : '',
      '点击查看完整流量与接口指标',
    ].filter(Boolean).join('\n');

    // 检查手动触发的压缩是否已完成，或已被用户撤回 / 手动停止
    const clearCompactingState = () => {
      state.compactingConvId = '';
      state.compactingBaselineReverts = 0;
      state.compactingSawRunning = false;
      state.compactingSubmittedAtMs = 0;
      state.compactingMaxSteps = 0;
      state.compactingUntilMs = 0;
    };
    if (state.compactingConvId && state.compactingConvId === cur.conversationId) {
      const curSteps = cur.stepCount || 0;
      const curReverts = cur.revertedStepsTotal || 0;
      if (curSteps > state.compactingMaxSteps) {
        state.compactingMaxSteps = curSteps;
      }
      if (isLive || cur.isCompacting) {
        state.compactingSawRunning = true;
      }
      const revertedNow = (state.compactingMaxSteps > 0 && curSteps < state.compactingMaxSteps)
        || curReverts > state.compactingBaselineReverts;
      const stoppedAfterStart = !isLive && !cur.isCompacting && (
        state.compactingSawRunning
        || revertedNow
        || h.state === 'ERROR_STOPPED'
        || (state.compactingSubmittedAtMs > 0 && Date.now() - state.compactingSubmittedAtMs >= 2500)
      );

      if (compactCount > state.compactingBaselineCount) {
        clearCompactingState();
        showToast('上下文压缩已完成');
      } else if (revertedNow || stoppedAfterStart || Date.now() > state.compactingUntilMs) {
        clearCompactingState();
      }
    } else if (state.compactingConvId && Date.now() > state.compactingUntilMs) {
      clearCompactingState();
    }

    // 轻量压缩操作角标（核心指标：当前上下文 Token 占用量；手动点击直接触发压缩，绝不后台自动代执行）
    const ch = cur.compactHint;
    const compactBadge = $('compact-badge');
    const isCompactingHere = Boolean(
      cur.isCompacting
      || (state.compactingConvId && state.compactingConvId === cur.conversationId && Date.now() <= state.compactingUntilMs),
    );
    if (isCompactingHere) {
      compactBadge.textContent = '压缩中…';
      compactBadge.title = '正在执行 /compact 上下文压缩，完成后上下文占用将自动回落';
      compactBadge.disabled = true;
      compactBadge.classList.remove('is-strong', 'hidden');
      compactBadge.classList.add('is-compacting');
    } else if (ch?.needed) {
      compactBadge.textContent = ch.label || '建议压缩';
      compactBadge.title = ch.message || '点击直接触发 /compact 上下文压缩';
      compactBadge.disabled = false;
      compactBadge.classList.toggle('is-strong', ch.level === 'strong');
      compactBadge.classList.remove('is-compacting', 'hidden');
    } else {
      compactBadge.disabled = false;
      compactBadge.classList.remove('is-strong', 'is-compacting');
      compactBadge.classList.add('hidden');
    }

    // 异常干预栏（仅在阻塞/断流/待确认时浮现；撤回、停止或恢复正常后自动收起）
    if (!INTERVENE_STATES.has(h.state) && state.prevHealthState && INTERVENE_STATES.has(state.prevHealthState)) {
      state.nudgeOpen = false;
    }
    state.prevHealthState = h.state || '';
    if ((h.state === 'STUCK_SUSPECTED' || h.state === 'ERROR_STOPPED') && h.alertKey && state.autoExpandedAlertKey !== h.alertKey) {
      state.autoExpandedAlertKey = h.alertKey;
      state.nudgeOpen = true;
    }
    const showIntervene = INTERVENE_STATES.has(h.state) || state.nudgeOpen;
    $('hero-intervene').classList.toggle('hidden', !showIntervene);
    $('nudge-box').classList.toggle('hidden', !state.nudgeOpen);

    // 3. 二级信息 A：阶段进度（无清单隐藏；100% 自动收起）
    const ms = cur.milestones;
    if (ms && ms.total > 0) {
      $('milestone-section').classList.remove('hidden');
      const isAllDone = ms.done >= ms.total;
      const msKey = `${cur.conversationId}:${isAllDone ? 'done' : 'active'}`;
      if (state.lastMsConvKey !== msKey) {
        state.lastMsConvKey = msKey;
        state.msExpandedOverride = null; // 阶段完成度切换时重置为智能默认态
      }
      const expanded = state.msExpandedOverride != null ? state.msExpandedOverride : !isAllDone;

      $('ms-done-icon').classList.toggle('hidden', !isAllDone);
      $('ms-counter').textContent = `${ms.done}/${ms.total} · ${ms.percent}%`;
      $('btn-toggle-ms').textContent = expanded ? '收起' : '展开';
      $('ms-body').classList.toggle('hidden', !expanded);

      const donePct = Math.min(100, Math.max(0, ms.percent));
      const activePct = ms.activeCount > 0 ? Math.min(100 - donePct, Math.round((ms.activeCount / ms.total) * 100)) : 0;
      $('ms-bar-done').style.width = `${donePct}%`;
      $('ms-bar-active').style.width = `${activePct}%`;

      const openBtn = $('btn-open-ms');
      if (ms.fileUri && window.sidecar?.ui?.toggleAuxPane) {
        openBtn.classList.remove('hidden');
        openBtn.onclick = (ev) => {
          ev.stopPropagation();
          window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri: ms.fileUri });
        };
      } else {
        openBtn.classList.add('hidden');
      }

      $('ms-list').innerHTML = (ms.items || []).map((it) => {
        const mark = it.state === 'done' ? '✓' : (it.state === 'active' ? '▶' : '○');
        const pad = it.indent > 0 ? `style="padding-left:${Math.min(it.indent * 12, 36)}px"` : '';
        return `<li class="ms-item ${esc(it.state)}" ${pad}><span class="ms-mark">${mark}</span><span>${esc(it.text)}</span></li>`;
      }).join('');
    } else {
      $('milestone-section').classList.add('hidden');
    }

    // 4. 二级信息 B：并发子代理与后台任务（数量为 0 时直接隐藏）
    const subs = cur.subagents || [];
    const bgs = cur.bgTasks || [];
    const totalSubItems = subs.length + bgs.length;
    if (totalSubItems > 0) {
      $('subagents-section').classList.remove('hidden');
      $('sub-count').textContent = String(totalSubItems);
      const canJump = Boolean(window.sidecar?.ui?.toggleConversation);

      const subHtml = subs.map((s) => {
        const sDot = dotClassFor(s.state, s.severity);
        const sSp = s.tokenSpeed || {};
        const sGenerating = GENERATING_STATES.has(s.state);
        const sRunning = RUNNING_STATES.has(s.state);
        let tpsText = '';
        if (sGenerating && sSp.turnLatestTps == null) {
          tpsText = '<span class="row-tps idle">测速中…</span>';
        } else if (sSp.turnLatestTps != null || sSp.latestTps != null) {
          const sDispTps = (sRunning && sSp.turnLatestTps != null) ? sSp.turnLatestTps : sSp.latestTps;
          tpsText = `<span class="row-tps ${sRunning ? '' : 'idle'}" title="${esc(formatTpsTooltip(sSp))}">${sDispTps.toFixed(1)} t/s</span>`;
        }
        return `
          <div class="flat-row">
            <div class="flat-row-top">
              <div class="flat-row-left">
                <span class="pulse-dot sm ${sDot}"></span>
                <span class="flat-row-title" title="${esc(s.role)}">${esc(s.role)}</span>
              </div>
              <div class="flat-row-right">
                ${tpsText}
                ${canJump ? `<button type="button" class="jump-icon-btn js-jump-conv" data-conv="${esc(s.conversationId)}" title="切换到子代理会话">↗</button>` : ''}
              </div>
            </div>
            <div class="flat-row-sub">${esc(s.badge)} · ${s.stepCount || 0} 步${s.headline ? ` · ${esc(s.headline)}` : ''}</div>
          </div>
        `;
      });

      const bgHtml = bgs.map((b) => `
        <div class="flat-row">
          <div class="flat-row-top">
            <div class="flat-row-left">
              <span class="pulse-dot sm st-healthy"></span>
              <span class="flat-row-title" title="${esc(b.description)}">${esc(b.description)}</span>
            </div>
            <div class="flat-row-right">
              <span class="row-tps idle">后台命令</span>
            </div>
          </div>
          <div class="flat-row-sub">任务标识：${esc(b.taskId)}</div>
        </div>
      `);

      $('sub-list').innerHTML = [...subHtml, ...bgHtml].join('');
    } else {
      $('subagents-section').classList.add('hidden');
      $('sub-list').innerHTML = '';
    }

    // 5. 三级背景：其他会话任务（排除当前正在查看的会话，活跃优先，已结束折叠）
    renderOtherSessions(gl.sessions || [], cur.conversationId);

    // 6. 流量与接口指标页签
    renderTrafficView(snap);

    // 7. 执行轨迹页签
    renderTimeline(cur.rounds || [], cur.totalRounds || 0);

    tickLiveClocks();
  }

  const BREAKDOWN_COLORS = ['#38bdf8', '#10b981', '#a855f7', '#f59e0b', '#f97316', '#64748b'];

  function renderTrafficView(snap) {
    const cur = snap.current || {};
    const sm = cur.metrics || null;
    const tok = cur.tokens || {};
    const net = snap.network || null;
    const gu = snap.globalUsage || null;
    const quota = snap.quota || null;
    const nowMs = Date.now() + state.serverClockSkewMs;

    // 1. AGY 服务端通信流量卡片（仅统计本机 Antigravity 自身进程与远端服务器通信）
    if (net?.available) {
      $('net-body').classList.remove('hidden');
      $('net-unavailable').classList.add('hidden');
      $('btn-reset-net').classList.remove('hidden');

      const ratePill = $('net-rate-pill');
      const totalBps = net.rates?.totalBps || 0;
      if (totalBps >= 256) {
        ratePill.textContent = `↑${fmtByteRate(net.rates.outBps)} · ↓${fmtByteRate(net.rates.inBps)}`;
        ratePill.classList.add('is-active');
      } else {
        ratePill.textContent = '静默 0 B/s';
        ratePill.classList.remove('is-active');
      }

      let bucket = net.today || { in: 0, out: 0, total: 0 };
      let scopeHint = `AGY 今日通信累计（${net.todayDate || ''}）`;
      let procs = Array.isArray(net.todayByProcess) ? net.todayByProcess : [];
      let isLiveScope = false;
      if (state.netScope === 'all') {
        bucket = net.allTime || { in: 0, out: 0, total: 0 };
        const sinceStr = fmtDateTimeShort(net.trackingSinceMs);
        scopeHint = sinceStr ? `自 ${sinceStr} 起 AGY 通信累计` : 'AGY 历史通信累计';
        procs = Array.isArray(net.allTimeByProcess) ? net.allTimeByProcess : [];
      } else if (state.netScope === 'live') {
        bucket = net.liveExternal || { in: 0, out: 0, total: 0 };
        scopeHint = `AGY 当前活跃服务端连接（${net.liveExternal?.count || 0} 条）`;
        procs = Array.isArray(net.byProcess) ? net.byProcess : [];
        isLiveScope = true;
      }

      const tot = bucket.total || 0;
      const txPct = tot > 0 ? Math.round(((bucket.out || 0) / tot) * 1000) / 10 : 0;
      const rxPct = tot > 0 ? Math.max(0, Math.round((100 - txPct) * 10) / 10) : 0;
      $('net-total-val').textContent = fmtBytes(tot);
      $('net-scope-hint').textContent = scopeHint;
      $('net-tx-val').textContent = `${fmtBytes(bucket.out || 0)}${tot > 0 ? ` (${txPct}%)` : ''}`;
      $('net-rx-val').textContent = `${fmtBytes(bucket.in || 0)}${tot > 0 ? ` (${rxPct}%)` : ''}`;
      $('net-bar-tx').style.width = `${txPct}%`;
      $('net-bar-rx').style.width = `${rxPct}%`;

      if (procs.length > 0) {
        $('net-proc-list').classList.remove('hidden');
        $('net-proc-list').innerHTML = procs.map((p) => {
          const metaSuffix = isLiveScope && p.pid
            ? ` <span class="metric-sub">#${esc(p.pid)} · ${esc(p.sockets)}连接</span>`
            : '';
          const rowTitle = isLiveScope && p.pid
            ? `PID ${p.pid} · ${p.sockets} 条 AGY 活跃远端连接`
            : `${p.name} · 上传 ${fmtBytes(p.out)} / 下载 ${fmtBytes(p.in)}`;
          return `
            <div class="kv-row">
              <span class="kv-key" title="${esc(rowTitle)}">${esc(p.name)}${metaSuffix}</span>
              <span class="kv-val tabular">↑${esc(fmtBytes(p.out))} · ↓${esc(fmtBytes(p.in))}</span>
            </div>
          `;
        }).join('');
      } else {
        $('net-proc-list').classList.add('hidden');
        $('net-proc-list').innerHTML = '';
      }

      const notes = ['仅计本机 AGY 进程与远端服务器通信（不含其他应用）'];
      if (net.liveExternal?.proxyCount > 0) {
        notes.push(`含 ${net.liveExternal.proxyCount} 条经本地代理连接`);
      }
      if (state.netScope === 'all') {
        notes.push(`已剔除本地 IPC 回环：累计 ${fmtBytes(net.allTimeLoopback?.total ?? net.todayLoopback?.total ?? 0)} / 活跃 ${fmtBytes(net.liveLoopback?.total || 0)}`);
      } else if (state.netScope === 'live') {
        notes.push(`已剔除本地 IPC 回环：当前活跃 ${fmtBytes(net.liveLoopback?.total || 0)}`);
      } else {
        notes.push(`已剔除本地 IPC 回环：今日 ${fmtBytes(net.todayLoopback?.total || 0)} / 活跃 ${fmtBytes(net.liveLoopback?.total || 0)}`);
      }
      $('net-footnote').textContent = notes.join(' · ');
    } else {
      $('net-body').classList.add('hidden');
      $('net-unavailable').classList.remove('hidden');
      $('net-unavailable').textContent = net?.reason || '当前系统不支持原生 AGY 进程网络流量抓测，下方词元与接口指标仍正常统计。';
      $('btn-reset-net').classList.add('hidden');
      $('net-rate-pill').textContent = '不可用';
      $('net-rate-pill').classList.remove('is-active');
    }

    // 2. 当前会话缓存命中率与接口指标
    const modelLabel = sm?.quality?.modelDisplayName || cur.health?.modelName || '';
    if (modelLabel) {
      $('sm-model-tag').textContent = modelLabel;
      $('sm-model-tag').title = sm?.quality?.responseModel ? `${modelLabel} (${sm.quality.responseModel})` : modelLabel;
      $('sm-model-tag').classList.remove('hidden');
    } else {
      $('sm-model-tag').classList.add('hidden');
    }

    const totalCalls = (sm?.apiCalls || 0) + (sm?.subagentApiCalls || 0);
    $('sm-calls-meta').textContent = sm?.subagentApiCalls
      ? `${sm.apiCalls} 次 (+${sm.subagentApiCalls} 子代理)`
      : `${totalCalls} 次调用`;

    // 统一口径：有子代理时整卡（总词元、缓存命中读取、新输入、总输出与命中率）均包含子代理，tooltip 中单独标出主会话值
    const hitRate = sm?.cache?.grandHitRate ?? sm?.cache?.hitRate ?? tok.grandCacheHitRate ?? tok.cacheHitRate ?? null;
    const latestHit = sm?.cache?.latestHitRate ?? tok.latestCacheHitRate ?? null;
    const savedCacheTok = sm?.cache?.savedTokens ?? ((tok.cache || 0) + (tok.subagentCache || 0));
    const smCacheEl = $('sm-cache-rate');
    smCacheEl.className = `cache-big-val tabular ${cacheToneClass(hitRate)}`;
    smCacheEl.textContent = hitRate != null ? `${hitRate.toFixed(1)}%` : '—';
    smCacheEl.title = (sm?.tokens?.subagentTotalTokens > 0 && sm?.cache?.hitRate != null)
      ? `含子代理综合命中率 ${hitRate?.toFixed(1)}%（主会话单独 ${sm.cache.hitRate.toFixed(1)}%）`
      : '';
    $('sm-cache-latest').textContent = latestHit != null ? `最新轮 ${latestHit.toFixed(1)}%` : '最新轮 —';
    $('sm-cache-saved').textContent = `缓存命中 ${fmtTokens(savedCacheTok)}`;
    $('sm-cache-bar').style.width = `${hitRate != null ? Math.min(100, Math.max(0, hitRate)) : 0}%`;

    const grandTot = tok.grandTotalTokens || tok.total || 0;
    const subTot = sm?.tokens?.subagentTotalTokens || 0;
    $('sm-tok-total').textContent = fmtTokens(grandTot);
    $('sm-tok-sub-total').textContent = subTot > 0 ? `含子代理 ${fmtTokens(subTot)}` : '主会话累计';

    $('sm-tok-cache').textContent = fmtTokens(savedCacheTok);
    const cwTok = sm?.cache?.cacheWriteTokens || tok.cacheWrite || 0;
    $('sm-tok-cw').textContent = cwTok > 0 ? `缓存写入 ${fmtTokens(cwTok)}` : '免重复计费';

    $('sm-tok-in').textContent = fmtTokens((tok.input || 0) + (tok.subagentInput || 0));
    const promptBytes = sm?.tokens?.latestPromptBytes || tok.latestPromptBytes || 0;
    $('sm-tok-prompt-bytes').textContent = promptBytes > 0 ? `单次载荷 ${fmtBytes(promptBytes)}` : '新鲜 Prompt';

    const grandOut = tok.grandTotalOutput || tok.output || 0;
    $('sm-tok-out').textContent = fmtTokens(grandOut);
    if (sm?.tokens?.hasThinkingBreakdown) {
      const thinkTotal = (sm.tokens.thinkingOutput || 0) + (sm.tokens.subagentThinkingOutput || 0);
      const respTotal = (sm.tokens.responseOutput || 0) + (sm.tokens.subagentResponseOutput || 0);
      const thinkPct = grandOut > 0 ? Math.round((thinkTotal / grandOut) * 100) : 0;
      $('sm-tok-out-split').textContent = `思 ${fmtTokens(thinkTotal)} · 正 ${fmtTokens(respTotal)}`;
      $('sm-tok-out-split').title = `思考输出 ${thinkTotal.toLocaleString()} t (${thinkPct}%) · 正文输出 ${respTotal.toLocaleString()} t`;
    } else if (tok.subagentOutput > 0) {
      $('sm-tok-out-split').textContent = `含子代理 ${fmtTokens(tok.subagentOutput)}`;
      $('sm-tok-out-split').title = '';
    } else {
      $('sm-tok-out-split').textContent = '模型总输出';
      $('sm-tok-out-split').title = '';
    }

    const lat = sm?.latency || {};
    const qual = sm?.quality || {};
    const hasApiDetail = lat.latestTtftMs != null || lat.avgTtftMs != null || lat.avgDecodeTps != null || tok.maxContextTokens > 0 || qual.retries > 0 || qual.modelCost > 0 || qual.creditCost > 0;
    if (hasApiDetail) {
      $('sm-api-grid').classList.remove('hidden');
      $('sm-ttft-val').textContent = lat.latestTtftMs != null ? fmtMsShort(lat.latestTtftMs) : fmtMsShort(lat.avgTtftMs);
      $('sm-ttft-sub').textContent = lat.avgTtftMs != null
        ? `均 ${fmtMsShort(lat.avgTtftMs)}${lat.maxTtftMs != null ? ` · 峰 ${fmtMsShort(lat.maxTtftMs)}` : ''}`
        : '首字响应延迟';

      const dispDecode = lat.latestDecodeTps ?? lat.avgDecodeTps;
      $('sm-decode-val').textContent = dispDecode != null ? `${dispDecode.toFixed(1)} t/s` : '—';
      $('sm-decode-sub').textContent = lat.avgDecodeTps != null && lat.latestDecodeTps != null
        ? `均 ${lat.avgDecodeTps.toFixed(1)} · ${fmtMsShort(lat.avgStreamMs)}`
        : (lat.avgStreamMs != null ? `流式均值 ${fmtMsShort(lat.avgStreamMs)}` : '流式解码速度');

      if (tok.maxContextTokens > 0) {
        $('sm-ctx-pct').textContent = tok.contextUsagePercent != null ? `${tok.contextUsagePercent.toFixed(1)}%` : '0%';
        $('sm-ctx-sub').textContent = `${fmtTokens(tok.currentContext || 0)} / ${fmtTokens(tok.maxContextTokens)}`;
      } else {
        $('sm-ctx-pct').textContent = fmtTokens(tok.currentContext || 0);
        $('sm-ctx-sub').textContent = '当前活跃上下文';
      }

      const retriesCount = qual.retries || 0;
      $('sm-retries-val').textContent = `${retriesCount} 次重试`;
      const costParts = [];
      if (qual.modelCost > 0) costParts.push(`$${qual.modelCost.toFixed(4)}`);
      if (qual.creditCost > 0) costParts.push(`${qual.creditCost} 积分`);
      $('sm-retries-sub').textContent = costParts.length
        ? costParts.join(' · ')
        : (retriesCount > 0 ? '含自动退避重连' : '请求全部一次成功');
    } else {
      $('sm-api-grid').classList.add('hidden');
    }

    const bd = sm?.contextBreakdown;
    if (bd && Array.isArray(bd.items) && bd.items.length > 0) {
      $('sm-breakdown-wrap').classList.remove('hidden');
      $('sm-breakdown-total').textContent = `合计 ${fmtTokens(bd.totalTokens)}`;
      $('sm-breakdown-bar').innerHTML = bd.items.map((it, idx) => `
        <div class="stacked-seg" style="width:${Math.max(1, it.percent)}%;background:${BREAKDOWN_COLORS[idx % BREAKDOWN_COLORS.length]}" title="${esc(it.label)}：${it.tokens.toLocaleString()} t (${it.percent}%)"></div>
      `).join('');
      $('sm-breakdown-legend').innerHTML = bd.items.map((it, idx) => `
        <span class="legend-item tabular" title="${it.tokens.toLocaleString()} t">
          <span class="legend-dot" style="background:${BREAKDOWN_COLORS[idx % BREAKDOWN_COLORS.length]}"></span>
          ${esc(it.label)} ${esc(fmtTokens(it.tokens))} (${it.percent}%)
        </span>
      `).join('');
    } else {
      $('sm-breakdown-wrap').classList.add('hidden');
    }

    // 3. 全机已统计会话累计
    if (gu?.available) {
      $('global-usage-section').classList.remove('hidden');
      const isTodayScope = state.guScope === 'today';
      const gBucket = isTodayScope ? gu.today : gu.allTime;
      $('gu-scan-meta').textContent = gu.scanning
        ? `扫描中 ${gu.scannedCount}/${gu.totalDbCount}`
        : `${gBucket?.conversationCount || 0} 个会话`;

      $('gu-tok-total').textContent = fmtTokens(gBucket?.totalTokens || 0);
      const guCostParts = [];
      if (gBucket?.modelCost > 0) guCostParts.push(`$${gBucket.modelCost.toFixed(4)}`);
      if (gBucket?.creditCost > 0) guCostParts.push(`${gBucket.creditCost} 积分`);
      $('gu-calls-sub').textContent = guCostParts.length
        ? `${(gBucket?.apiCalls || 0).toLocaleString()} 次 · ${guCostParts.join(' / ')}`
        : `${(gBucket?.apiCalls || 0).toLocaleString()} 次接口调用`;
      const guPerfParts = [];
      if (gBucket?.avgTtftMs != null) {
        guPerfParts.push(`全局首字延迟 TTFT：均值 ${fmtMsShort(gBucket.avgTtftMs)}${gBucket.maxTtftMs != null ? ` / 峰值 ${fmtMsShort(gBucket.maxTtftMs)}` : ''}`);
      }
      if (gBucket?.decodeTps != null) {
        guPerfParts.push(`全局流式解码均速：${gBucket.decodeTps.toFixed(1)} t/s${gBucket.avgStreamMs != null ? `（均值耗时 ${fmtMsShort(gBucket.avgStreamMs)}）` : ''}`);
      }
      if (gBucket?.modelCost > 0) guPerfParts.push(`累计模型费用：$${gBucket.modelCost.toFixed(4)}`);
      if (gBucket?.creditCost > 0) guPerfParts.push(`累计积分消耗：${gBucket.creditCost}`);
      $('gu-tok-total').parentElement.title = [
        `${isTodayScope ? '今日' : '全部'}累计总词元：${(gBucket?.totalTokens || 0).toLocaleString()} t`,
        ...guPerfParts,
      ].join('\n');

      const gRate = gBucket?.cacheHitRate ?? null;
      const gRateEl = $('gu-cache-rate');
      gRateEl.className = `stat-val tabular ${cacheToneClass(gRate)}`;
      gRateEl.textContent = gRate != null ? `${gRate.toFixed(1)}%` : '—';
      $('gu-cache-read').textContent = `命中 ${fmtTokens(gBucket?.cacheRead || 0)}`;

      $('gu-tok-in').textContent = fmtTokens(gBucket?.input || 0);
      const cwGlobal = gBucket?.cacheWrite || 0;
      $('gu-retries').textContent = cwGlobal > 0
        ? `写入 ${fmtTokens(cwGlobal)} · 重试 ${gBucket?.retries || 0}`
        : `累计重试 ${gBucket?.retries || 0} 次`;

      $('gu-tok-out').textContent = fmtTokens(gBucket?.output || 0);
      if (gBucket?.hasThinkingBreakdown) {
        $('gu-out-split').textContent = `思 ${fmtTokens(gBucket.thinkingOutput)} · 正 ${fmtTokens(gBucket.responseOutput)}`;
      } else if (gBucket?.decodeTps != null) {
        $('gu-out-split').textContent = `解码 ${gBucket.decodeTps.toFixed(1)} t/s`;
      } else {
        $('gu-out-split').textContent = '总生成输出';
      }
      $('gu-tok-out').parentElement.title = guPerfParts.join('\n');

      const tops = isTodayScope ? (gu.topSessionsToday || []) : (gu.topSessions || []);
      $('gu-top-heading').textContent = isTodayScope ? '今日消耗最高会话' : '词元消耗最高会话';
      if (tops.length > 0) {
        $('gu-top-wrap').classList.remove('hidden');
        $('gu-top-list').innerHTML = tops.map((s) => `
          <div class="flat-row interactive js-pick-session ${s.conversationId === cur.conversationId ? 'is-selected' : ''}" data-conv="${esc(s.conversationId)}">
            <div class="flat-row-top">
              <div class="flat-row-left">
                ${s.workspaceName ? `<span class="flat-row-ws" title="${esc(s.workspaceName)}">${esc(s.workspaceName)}</span>` : ''}
                <span class="flat-row-title" title="${esc(s.title)}">${s.isSubagent ? '[子代理] ' : ''}${esc(s.title)}</span>
              </div>
              <div class="flat-row-right">
                <span class="row-tps idle tabular">${esc(fmtTokens(s.totalTokens))}</span>
              </div>
            </div>
            <div class="flat-row-sub tabular">${s.cacheHitRate != null ? `缓存 ${s.cacheHitRate.toFixed(1)}% · ` : ''}${s.apiCalls} 次调用 · 输出 ${esc(fmtTokens(s.output))}</div>
          </div>
        `).join('');
      } else {
        $('gu-top-wrap').classList.add('hidden');
      }
    } else {
      $('global-usage-section').classList.add('hidden');
    }

    // 4. 账号与模型配额（接口有返回时显示）
    if (quota && ((quota.groups && quota.groups.length > 0) || quota.credits)) {
      $('quota-section').classList.remove('hidden');
      if (quota.planName) {
        $('quota-plan-tag').textContent = quota.planName;
        $('quota-plan-tag').classList.remove('hidden');
      } else {
        $('quota-plan-tag').classList.add('hidden');
      }

      const cr = quota.credits;
      const crParts = [];
      const crTips = [];
      if (cr?.availablePrompt != null) {
        crParts.push(`Prompt ${cr.availablePrompt.toLocaleString()}`);
        crTips.push(`Prompt 剩余 ${cr.availablePrompt.toLocaleString()}${cr.monthlyPrompt != null ? ` / 月额 ${cr.monthlyPrompt.toLocaleString()}` : ''}${cr.usedPrompt != null ? `（已用 ${cr.usedPrompt.toLocaleString()}）` : ''}`);
      }
      if (cr?.availableFlow != null) {
        crParts.push(`Flow ${cr.availableFlow.toLocaleString()}`);
        crTips.push(`Flow 剩余 ${cr.availableFlow.toLocaleString()}${cr.monthlyFlow != null ? ` / 月额 ${cr.monthlyFlow.toLocaleString()}` : ''}${cr.usedFlow != null ? `（已用 ${cr.usedFlow.toLocaleString()}）` : ''}`);
      }
      if (cr?.availableFlex != null) {
        crParts.push(`Flex ${cr.availableFlex.toLocaleString()}`);
        crTips.push(`Flex 弹性额度剩余 ${cr.availableFlex.toLocaleString()}`);
      }
      $('quota-credits-meta').textContent = crParts.length ? `额度 ${crParts.join(' / ')}` : '';
      $('quota-credits-meta').title = crTips.join('\n');

      $('quota-list').innerHTML = (quota.groups || []).map((g) => {
        const pct = Math.min(100, Math.max(0, g.remainingPercent || 0));
        const exhausted = pct <= 0;
        const fillCls = pct <= 15 ? 'quota-fill-low' : (pct <= 40 ? 'quota-fill-warn' : 'quota-fill-ok');
        const resetStr = g.resetAtMs ? fmtResetCountdown(g.resetAtMs, nowMs) : '';
        const metaText = exhausted
          ? `已耗尽${resetStr ? ` · ${resetStr}` : ''}`
          : `${pct.toFixed(1)}%${resetStr ? ` · ${resetStr}` : ''}`;
        return `
          <div class="quota-row">
            <div class="quota-row-head">
              <span class="quota-label" title="${esc(g.label)}（${g.modelsCount} 个模型共享）">${esc(g.label)}</span>
              <span class="quota-meta tabular ${exhausted ? 'is-exhausted' : ''}">${esc(metaText)}</span>
            </div>
            <div class="progress-track">
              <div class="${fillCls}" style="width:${pct}%"></div>
            </div>
          </div>
        `;
      }).join('');
    } else {
      $('quota-section').classList.add('hidden');
    }
  }

  function buildFlatSessionRow(s) {
    const sDot = dotClassFor(s.state, s.severity);
    const sp = s.tokenSpeed || {};
    const sGenerating = GENERATING_STATES.has(s.state);
    const sRunning = RUNNING_STATES.has(s.state);
    let tpsHtml;
    if (sGenerating && sp.turnLatestTps == null) {
      tpsHtml = '<span class="row-tps idle">测速中…</span>';
    } else if (sp.turnLatestTps != null || sp.latestTps != null) {
      const displayTps = (sRunning && sp.turnLatestTps != null) ? sp.turnLatestTps : sp.latestTps;
      tpsHtml = `<span class="row-tps ${sRunning ? '' : 'idle'}" title="${esc(formatTpsTooltip(sp))}">${displayTps.toFixed(1)} t/s</span>`;
    } else {
      tpsHtml = '<span class="row-tps idle">—</span>';
    }

    const subParts = [s.badge];
    if (s.milestoneLabel) subParts.push(`阶段 ${s.milestoneLabel}`);
    if (sp.avgTps != null) subParts.push(`均值 ${sp.avgTps.toFixed(1)} t/s`);
    if (s.compactHint?.needed) subParts.push(s.compactHint.label || '建议压缩');
    if (s.headline && (s.isActive || s.state === 'ERROR_STOPPED')) subParts.push(s.headline);

    return `
      <div class="flat-row interactive js-pick-session" data-conv="${esc(s.conversationId)}">
        <div class="flat-row-top">
          <div class="flat-row-left">
            <span class="pulse-dot sm ${sDot}"></span>
            ${s.workspaceName ? `<span class="flat-row-ws" title="${esc(s.workspaceName)}">${esc(s.workspaceName)}</span>` : ''}
            <span class="flat-row-title" title="${esc(s.title)}">${esc(s.title)}</span>
          </div>
          <div class="flat-row-right">
            ${tpsHtml}
            ${window.sidecar?.ui?.toggleConversation ? `<button type="button" class="jump-icon-btn js-open-host-conv" data-conv="${esc(s.conversationId)}" title="切换到该会话窗口">↗</button>` : ''}
          </div>
        </div>
        <div class="flat-row-sub">${esc(subParts.join(' · '))}</div>
      </div>
    `;
  }

  function renderOtherSessions(sessions, currentId) {
    const others = sessions.filter((s) => s.conversationId !== currentId);
    if (!others.length) {
      $('parallel-section').classList.add('hidden');
      return;
    }
    $('parallel-section').classList.remove('hidden');

    const activeOthers = others.filter((s) => s.isActive);
    const idleOthers = others.filter((s) => !s.isActive);

    if (activeOthers.length > 0) {
      $('parallel-active-wrap').classList.remove('hidden');
      $('parallel-active-count').textContent = String(activeOthers.length);
      $('parallel-active-list').innerHTML = activeOthers.map(buildFlatSessionRow).join('');
    } else {
      $('parallel-active-wrap').classList.add('hidden');
      $('parallel-active-list').innerHTML = '';
    }

    if (idleOthers.length > 0) {
      $('parallel-idle-wrap').classList.remove('hidden');
      $('idle-toggle-label').textContent = `近期已结束任务 (${idleOthers.length})`;
      $('idle-toggle-arrow').textContent = state.idleSessionsExpanded ? '▾' : '▸';
      $('parallel-idle-list').classList.toggle('hidden', !state.idleSessionsExpanded);
      if (state.idleSessionsExpanded) {
        $('parallel-idle-list').innerHTML = idleOthers.map(buildFlatSessionRow).join('');
      }
    } else {
      $('parallel-idle-wrap').classList.add('hidden');
      $('parallel-idle-list').innerHTML = '';
    }
  }

  function renderTimeline(rounds, totalCount) {
    $('timeline-count').textContent = String(totalCount || rounds.length);

    const filtered = rounds.filter((r) => {
      if (state.tlFilter === 'error') return r.kind === 'error' || r.hasError;
      if (state.tlFilter === 'slow') {
        const dur = r.totalMs || 0;
        return dur >= 15_000 || (r.tools || []).some((t) => (t.durationMs || 0) >= 15_000);
      }
      return true;
    });

    if (!filtered.length) {
      $('timeline-list').innerHTML = '';
      $('timeline-empty').classList.remove('hidden');
      return;
    }
    $('timeline-empty').classList.add('hidden');

    $('timeline-list').innerHTML = filtered.map((r) => {
      if (r.kind === 'error') {
        return `
          <article class="tl-card is-error">
            <div class="tl-head">
              <span>#${esc(r.stepIndex)} · 接口异常</span>
              <span class="tabular">${esc(fmtTimeOfDay(r.startedAtMs))}</span>
            </div>
            <div class="tl-err">${esc(r.error)}</div>
          </article>
        `;
      }
      if (r.kind === 'compact') {
        const cpTok = r.tokens;
        const cpMeta = cpTok
          ? [
            cpTok.cacheHitRate != null ? `缓存 ${cpTok.cacheHitRate.toFixed(0)}%` : '',
            `入 ${fmtTokens(cpTok.in)}`,
            cpTok.cache > 0 ? `缓 ${fmtTokens(cpTok.cache)}` : '',
            `出 ${fmtTokens(cpTok.out)}`,
          ].filter(Boolean).join(' · ')
          : '';
        return `
          <article class="tl-card is-compact">
            <div class="tl-head">
              <span>#${esc(r.stepIndex)} · 上下文压缩</span>
              <span class="tabular">${esc(fmtTimeOfDay(r.startedAtMs))}</span>
            </div>
            <div class="tl-title">${esc(r.title)}</div>
            ${cpMeta ? `<div class="tl-metrics tabular">${esc(cpMeta)}</div>` : ''}
          </article>
        `;
      }

      const am = r.apiMetrics || null;
      const tpsStr = r.tps != null ? `${r.tps.toFixed(1)} t/s` : '';
      const thinkStr = r.thinkingMs != null ? `思考 ${fmtShortDur(r.thinkingMs / 1000)}` : '';
      const toolsStr = r.toolsMs != null ? `工具 ${fmtShortDur(r.toolsMs / 1000)}` : '';
      const durMeta = [tpsStr, thinkStr, toolsStr].filter(Boolean).join(' · ') || fmtTimeOfDay(r.startedAtMs);

      const roundHitRate = am?.cacheHitRate ?? r.tokens?.cacheHitRate ?? null;
      const metricParts = [];
      if (roundHitRate != null) metricParts.push(`缓存 ${roundHitRate.toFixed(0)}%`);
      if (am?.ttftMs != null) metricParts.push(`首字 ${fmtMsShort(am.ttftMs)}`);
      if (am?.decodeTps != null) metricParts.push(`解码 ${am.decodeTps.toFixed(1)} t/s`);
      const effIn = am?.input ?? r.tokens?.in ?? 0;
      const effCache = am?.cacheRead ?? r.tokens?.cache ?? 0;
      const effOut = am?.output ?? r.tokens?.out ?? 0;
      const effCw = am?.cacheWrite ?? 0;
      if (effIn > 0 || effCache > 0 || effOut > 0 || effCw > 0) {
        const outDetail = am?.thinkingOutput > 0
          ? `${fmtTokens(effOut)}(思${fmtTokens(am.thinkingOutput)})`
          : fmtTokens(effOut);
        const cwPart = effCw > 0 ? ` / 写 ${fmtTokens(effCw)}` : '';
        metricParts.push(`入 ${fmtTokens(effIn)} / 缓 ${fmtTokens(effCache)}${cwPart} / 出 ${outDetail}`);
      }
      if (am?.retries > 0) metricParts.push(`重试 ${am.retries}`);
      const roundMetricsHtml = metricParts.length
        ? `<div class="tl-metrics tabular">${esc(metricParts.join(' · '))}</div>`
        : '';

      const toolsHtml = (r.tools || []).map((t) => {
        const icon = t.status === 'ERROR'
          ? '✗'
          : ((t.status === 'INTERRUPTED' || t.status === 'CANCELED')
            ? '⊘'
            : (t.status === 'PENDING' || t.status === 'RUNNING' || t.status === 'WAITING' ? '⟳' : '✓'));
        const durSec = t.durationMs != null ? t.durationMs / 1000 : null;
        const isSlow = durSec != null && durSec >= 15;
        const durLabel = durSec != null
          ? fmtShortDur(durSec)
          : (t.status === 'CANCELED'
            ? '已取消'
            : (t.status === 'INTERRUPTED'
              ? '已中断'
              : (t.status === 'WAITING' ? '待确认…' : (t.status === 'PENDING' ? '进行中…' : ''))));
        return `
          <div class="tl-tool ${isSlow ? 'slow' : ''}">
            <span class="tl-tool-label" title="${esc(t.detail || t.label)}">${icon} ${esc(t.label)}</span>
            <span class="tl-tool-dur">${esc(durLabel)}</span>
          </div>
          ${t.error ? `<div class="tl-err">${esc(t.error)}</div>` : ''}
        `;
      }).join('');

      return `
        <article class="tl-card ${r.hasError ? 'is-error' : ''}">
          <div class="tl-head">
            <span>第 ${esc(r.roundNum)} 轮 · #${esc(r.stepIndex)}</span>
            <span class="tabular">${esc(durMeta)}</span>
          </div>
          <div class="tl-title">${esc(r.title)}</div>
          ${roundMetricsHtml}
          ${toolsHtml ? `<div class="tl-tools">${toolsHtml}</div>` : ''}
        </article>
      `;
    }).join('');
  }

  // ---------- 客户端 1 秒级平滑秒表 ----------
  function tickLiveClocks() {
    const cur = state.snap?.current;
    const h = cur?.health;
    if (!h) return;

    const estServerNow = Date.now() + state.serverClockSkewMs;
    const isActivelyTicking = RUNNING_STATES.has(h.state)
      || h.state === 'STUCK_SUSPECTED'
      || (h.state === 'WAITING_USER' && h.turnDurationSec == null);

    // 右上角秒表仅在实时运行态或阻塞待确认中显示，已停机/审阅静态方案时隐藏
    if (isActivelyTicking && h.startedAtMs) {
      const liveStepSec = Math.max(0, Math.floor((estServerNow - h.startedAtMs) / 1000));
      $('hero-timer').textContent = fmtClockTimer(liveStepSec);
      $('hero-timer').classList.remove('hidden');
    } else {
      $('hero-timer').classList.add('hidden');
    }

    if (isActivelyTicking && h.turnStartedAtMs) {
      const liveTurnSec = Math.max(0, Math.floor((estServerNow - h.turnStartedAtMs) / 1000));
      $('metric-dur').textContent = fmtShortDur(liveTurnSec);
    } else {
      $('metric-dur').textContent = fmtShortDur(h.totalTurnSec || 0);
    }
  }
  setInterval(tickLiveClocks, 1000);

  // ---------- 轮询循环 ----------
  let pollTimer = null;
  let pollSeq = 0;
  async function pollOnce() {
    const mySeq = ++pollSeq;
    const currentHostConv = hostConvId();
    if (currentHostConv !== state.lastHostConvId) {
      state.lastHostConvId = currentHostConv;
      state.deletedHostConvId = '';
      state.overrideConvId = '';
      state.etag = '';
    }

    const targetConv = activeTargetConvId();
    try {
      const qs = new URLSearchParams();
      if (targetConv) {
        qs.set('conversationId', targetConv);
      } else if (window.sidecar) {
        qs.set('conversationId', '__none__');
      }
      if (state.etag) qs.set('etag', state.etag);

      const data = await apiGet(`/api/state?${qs.toString()}`);
      if (mySeq !== pollSeq) return;
      if (data.uiBuildKey) {
        if (state.uiBuildKey && state.uiBuildKey !== data.uiBuildKey) {
          window.location.reload();
          return;
        }
        state.uiBuildKey = data.uiBuildKey;
      }
      if (Number.isFinite(data.serverNow)) {
        state.serverClockSkewMs = data.serverNow - Date.now();
      }

      if (targetConv && data.current?.deleted) {
        if (state.overrideConvId === targetConv) {
          state.overrideConvId = '';
          state.etag = '';
          showToast('该会话已删除，已切回当前窗口');
          clearTimeout(pollTimer);
          pollTimer = setTimeout(pollOnce, 60);
          return;
        }
        state.deletedHostConvId = targetConv;
      }

      if (!data.unchanged) {
        state.etag = data.etag || '';
        state.snap = data;
        if (data.settings) {
          state.settings = data.settings;
          syncSettingsInputs(data.settings);
        }
        renderAll();
      }
    } catch {
      // 瞬态网络或服务重载静默恢复
    } finally {
      if (mySeq === pollSeq) {
        const curState = state.snap?.current?.health?.state || 'IDLE';
        const nextDelay = LIVE_STATES.has(curState) ? ACTIVE_POLL_MS : IDLE_POLL_MS;
        clearTimeout(pollTimer);
        pollTimer = setTimeout(pollOnce, nextDelay);
      }
    }
  }

  function syncSettingsInputs(s) {
    if (!s || state.drawerSettingsOpen) return;
    $('set-think-warn').value = s.thinkingWarnSec;
    $('set-think-stuck').value = s.thinkingStuckSec;
    $('set-cmd-stuck').value = s.commandQuietStuckSec;
    $('set-compact-ctx').value = Math.round((s.compactHintContextTokens || 160000) / 10000);
  }

  // ---------- 交互事件绑定 ----------
  function switchTab(nextTab) {
    state.tab = nextTab;
    document.querySelectorAll('.seg-tab').forEach((b) => {
      const active = b.dataset.tab === state.tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    $('view-overview').classList.toggle('active', state.tab === 'overview');
    $('view-traffic').classList.toggle('active', state.tab === 'traffic');
    $('view-timeline').classList.toggle('active', state.tab === 'timeline');
  }

  document.querySelectorAll('.seg-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.querySelectorAll('.js-open-traffic').forEach((btn) => {
    btn.addEventListener('click', () => switchTab('traffic'));
  });

  document.querySelectorAll('[data-net-scope]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.netScope = btn.dataset.netScope;
      document.querySelectorAll('[data-net-scope]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      if (state.snap) renderTrafficView(state.snap);
    });
  });

  document.querySelectorAll('[data-gu-scope]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.guScope = btn.dataset.guScope;
      document.querySelectorAll('[data-gu-scope]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      if (state.snap) renderTrafficView(state.snap);
    });
  });

  let resetNetConfirmTimer = null;
  let resetNetArmed = false;
  const disarmResetNet = () => {
    resetNetArmed = false;
    clearTimeout(resetNetConfirmTimer);
    resetNetConfirmTimer = null;
    const btn = $('btn-reset-net');
    if (btn) {
      btn.textContent = '清零';
      btn.classList.remove('is-confirm');
    }
  };

  $('btn-reset-net').addEventListener('click', async () => {
    const btn = $('btn-reset-net');
    if (btn.disabled) return;
    if (!resetNetArmed) {
      resetNetArmed = true;
      btn.textContent = '确认清零?';
      btn.classList.add('is-confirm');
      clearTimeout(resetNetConfirmTimer);
      resetNetConfirmTimer = setTimeout(disarmResetNet, 3500);
      return;
    }
    disarmResetNet();
    btn.disabled = true;
    // 递增 pollSeq，防止清零期间在途的旧轮询快照回写旧流量
    pollSeq += 1;
    try {
      const res = await apiPost('/api/traffic/reset', {});
      if (res?.ok && state.snap) {
        state.snap.network = res.network;
        state.etag = '';
        renderAll();
        showToast('已清零 AGY 服务端流量累计');
      } else {
        showToast('重置失败');
      }
    } catch {
      showToast('重置失败');
    } finally {
      btn.disabled = false;
      clearTimeout(pollTimer);
      pollTimer = setTimeout(pollOnce, IDLE_POLL_MS);
    }
  });

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.tlFilter = chip.dataset.filter;
      document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
      if (state.snap?.current) {
        renderTimeline(state.snap.current.rounds || [], state.snap.current.totalRounds || 0);
      }
    });
  });

  $('ms-header').addEventListener('click', () => {
    const currentlyHidden = $('ms-body').classList.contains('hidden');
    state.msExpandedOverride = currentlyHidden;
    renderAll();
  });

  $('btn-toggle-idle').addEventListener('click', () => {
    state.idleSessionsExpanded = !state.idleSessionsExpanded;
    renderAll();
  });

  $('btn-back-own').addEventListener('click', () => {
    state.overrideConvId = '';
    state.etag = '';
    pollOnce();
  });

  const handleSessionRowClick = (e) => {
    const openHostBtn = e.target.closest('.js-open-host-conv');
    if (openHostBtn) {
      e.stopPropagation();
      const cid = openHostBtn.dataset.conv;
      if (cid) {
        state.overrideConvId = cid === hostConvId() ? '' : cid;
        state.etag = '';
        if (window.sidecar?.ui?.toggleConversation) {
          window.sidecar.ui.toggleConversation(cid);
        }
        pollOnce();
      }
      return;
    }
    const row = e.target.closest('.js-pick-session');
    if (row) {
      const cid = row.dataset.conv || '';
      state.overrideConvId = cid === hostConvId() ? '' : cid;
      state.etag = '';
      pollOnce();
    }
  };

  $('parallel-active-list').addEventListener('click', handleSessionRowClick);
  $('parallel-idle-list').addEventListener('click', handleSessionRowClick);
  $('gu-top-list').addEventListener('click', handleSessionRowClick);

  $('sub-list').addEventListener('click', (e) => {
    const jumpBtn = e.target.closest('.js-jump-conv');
    if (!jumpBtn) return;
    const cid = jumpBtn.dataset.conv;
    if (cid && window.sidecar?.ui?.toggleConversation) {
      window.sidecar.ui.toggleConversation(cid);
    }
  });

  $('btn-settings').addEventListener('click', () => {
    state.drawerSettingsOpen = !state.drawerSettingsOpen;
    if (state.drawerSettingsOpen && state.settings) {
      $('set-think-warn').value = state.settings.thinkingWarnSec;
      $('set-think-stuck').value = state.settings.thinkingStuckSec;
      $('set-cmd-stuck').value = state.settings.commandQuietStuckSec;
      $('set-compact-ctx').value = Math.round((state.settings.compactHintContextTokens || 160000) / 10000);
    }
    $('drawer-settings').classList.toggle('hidden', !state.drawerSettingsOpen);
    $('btn-settings').setAttribute('aria-expanded', String(state.drawerSettingsOpen));
  });

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await apiPost('/api/settings', {
        thinkingWarnSec: Number($('set-think-warn').value),
        thinkingStuckSec: Number($('set-think-stuck').value),
        commandQuietStuckSec: Number($('set-cmd-stuck').value),
        compactHintContextTokens: Math.round(Number($('set-compact-ctx').value || 16) * 10000),
      });
      state.settings = res.settings;
      state.drawerSettingsOpen = false;
      $('drawer-settings').classList.add('hidden');
      state.etag = '';
      pollOnce();
      showToast('预警阈值已保存');
    } catch {
      showToast('保存失败');
    }
  });

  $('btn-reset-settings').addEventListener('click', async () => {
    try {
      const res = await apiPost('/api/settings', {
        thinkingWarnSec: 60,
        thinkingStuckSec: 180,
        commandQuietStuckSec: 90,
        approvalHintSec: 15,
        compactHintContextTokens: 160000,
      });
      state.settings = res.settings;
      state.drawerSettingsOpen = false;
      $('drawer-settings').classList.add('hidden');
      syncSettingsInputs(state.settings);
      state.etag = '';
      pollOnce();
      showToast('已恢复默认阈值');
    } catch {
      showToast('重置失败');
    }
  });

  $('btn-toggle-nudge').addEventListener('click', () => {
    state.nudgeOpen = !state.nudgeOpen;
    $('nudge-box').classList.toggle('hidden', !state.nudgeOpen);
  });

  $('btn-cancel-nudge').addEventListener('click', () => {
    state.nudgeOpen = false;
    renderAll();
  });

  $('btn-send-nudge').addEventListener('click', async () => {
    const msg = $('nudge-input').value.trim();
    const cid = activeTargetConvId();
    if (!msg) return;
    if (!cid || !window.sidecar?.agent?.sendMessage) {
      showToast('未连接宿主会话通道');
      return;
    }
    const btn = $('btn-send-nudge');
    btn.disabled = true;
    try {
      await window.sidecar.agent.sendMessage(msg, cid);
      state.nudgeOpen = false;
      renderAll();
      showToast('消息已发送至会话');
    } catch (err) {
      showToast(`发送失败：${err.message || '未知错误'}`);
    } finally {
      btn.disabled = false;
    }
  });

  $('compact-badge').addEventListener('click', async () => {
    const cur = state.snap?.current;
    const h = cur?.health || {};
    const cid = activeTargetConvId();
    if (!cur) return;

    if (h.state === 'WAITING_APPROVAL') {
      showToast('请先处理左侧权限确认弹窗后再点击压缩');
      return;
    }
    if (['THINKING', 'THINKING_DEEP', 'TOOL_ACTIVE', 'SUBAGENT_RUNNING'].includes(h.state)) {
      showToast('当前轮次执行中，请待停止后再点击压缩');
      return;
    }

    $('compact-badge').blur();
    document.activeElement?.blur?.();

    const resetCompacting = () => {
      state.compactingConvId = '';
      state.compactingBaselineReverts = 0;
      state.compactingSawRunning = false;
      state.compactingSubmittedAtMs = 0;
      state.compactingMaxSteps = 0;
      state.compactingUntilMs = 0;
    };

    state.compactingConvId = cid || cur.conversationId || '';
    state.compactingBaselineCount = cur.compactCount || 0;
    state.compactingBaselineReverts = cur.revertedStepsTotal || 0;
    state.compactingMaxSteps = cur.stepCount || 0;
    state.compactingSawRunning = false;
    state.compactingSubmittedAtMs = 0;
    state.compactingUntilMs = Date.now() + 60_000;
    renderAll();

    try {
      // 必须调用 toggleConversation(cid)，通知宿主把键盘焦点从右侧 Sidecar WebView 切回左侧对话窗输入框
      if (cid && window.sidecar?.ui?.toggleConversation) {
        window.sidecar.ui.toggleConversation(cid);
        await new Promise((r) => setTimeout(r, 260));
      }
      const res = await apiPost('/api/compact', {
        conversationId: cid,
        title: cur.title || '',
        workspaceName: cur.workspaceName || '',
      });
      if (res?.ok) {
        state.compactingSubmittedAtMs = Date.now();
        showToast(res.alreadyCompacting ? '当前会话正在压缩中' : '已触发上下文压缩（约 15～30s 完成）');
      } else {
        resetCompacting();
        renderAll();
        showToast(res?.reason || '触发压缩失败');
      }
    } catch (err) {
      resetCompacting();
      renderAll();
      showToast(`触发失败：${err.message || '网络异常'}`);
    }
  });

  $('btn-copy-diag').addEventListener('click', async () => {
    const cur = state.snap?.current;
    const h = cur?.health;
    if (!cur || !h) return;
    const sp = cur.tokenSpeed || {};
    const tok = cur.tokens || {};
    const sm = cur.metrics || null;
    const net = state.snap?.network || null;
    const gu = state.snap?.globalUsage || null;
    const quota = state.snap?.quota || null;
    const hitRate = sm?.cache?.grandHitRate ?? sm?.cache?.hitRate ?? tok.grandCacheHitRate ?? tok.cacheHitRate ?? null;
    const promptBytes = sm?.tokens?.latestPromptBytes || tok.latestPromptBytes || 0;
    const lines = [
      `### Antigravity 会话监控 · 诊断快照`,
      `- **会话编号**：\`${cur.conversationId || '未关联'}\``,
      `- **会话主题**：${cur.title || '未命名'}`,
      `- **当前状态**：${h.badge}`,
      `- **当前动作**：${h.headline}`,
      h.detail ? `- **补充详情**：${h.detail}` : '',
      sp.latestTps != null
        ? `- **生成速度**：最新 ${sp.latestTps.toFixed(1)} t/s（均值 ${(sp.avgTps ?? sp.latestTps).toFixed(1)} t/s · 峰值 ${(sp.peakTps ?? sp.latestTps).toFixed(1)} t/s${sp.decodeTps != null ? ` · 流式解码 ${sp.decodeTps.toFixed(1)} t/s` : ''}）`
        : '',
      `- **本轮耗时**：${$('metric-dur').textContent}（累计 ${cur.stepCount || 0} 步）`,
      `- **上下文与词元**：当前 ${(tok.currentContext || 0).toLocaleString()} t${tok.maxContextTokens ? ` / ${tok.maxContextTokens.toLocaleString()} t (${tok.contextUsagePercent ?? 0}%)` : ''}${promptBytes > 0 ? ` · 单次载荷 ${fmtBytes(promptBytes)}` : ''} · 累计总词元 ${(tok.grandTotalTokens || tok.total || 0).toLocaleString()} t（输入 ${((tok.input || 0) + (tok.subagentInput || 0)).toLocaleString()} / 缓存 ${(sm?.cache?.savedTokens ?? tok.cache ?? 0).toLocaleString()}${(sm?.cache?.cacheWriteTokens || tok.cacheWrite) ? ` / 写入 ${(sm?.cache?.cacheWriteTokens || tok.cacheWrite).toLocaleString()}` : ''} / 输出 ${(tok.grandTotalOutput || tok.output || 0).toLocaleString()}）`,
      hitRate != null
        ? `- **缓存命中率**：累计 ${hitRate.toFixed(1)}%${sm?.cache?.latestHitRate != null ? ` · 最新轮 ${sm.cache.latestHitRate.toFixed(1)}%` : ''}`
        : '',
      sm?.latency?.avgTtftMs != null
        ? `- **接口延迟与质量**：TTFT 均值 ${fmtMsShort(sm.latency.avgTtftMs)}（最新 ${fmtMsShort(sm.latency.latestTtftMs)}）· 调用 ${(sm.apiCalls || 0) + (sm.subagentApiCalls || 0)} 次 · 重试 ${sm.quality?.retries || 0} 次`
        : '',
      net?.available
        ? `- **AGY 服务端流量**：今日 ${fmtBytes(net.today?.total || 0)}（↑${fmtBytes(net.today?.out || 0)} / ↓${fmtBytes(net.today?.in || 0)}）· 历史累计 ${fmtBytes(net.allTime?.total || 0)}（↑${fmtBytes(net.allTime?.out || 0)} / ↓${fmtBytes(net.allTime?.in || 0)}）`
        : '',
      gu?.allTime?.totalTokens
        ? `- **全机累计词元**：累计 ${fmtTokens(gu.allTime.totalTokens)}（${gu.allTime.conversationCount} 会话 · 缓存 ${gu.allTime.cacheHitRate != null ? `${gu.allTime.cacheHitRate.toFixed(1)}%` : '—'}）${gu.today?.totalTokens ? ` · 今日 ${fmtTokens(gu.today.totalTokens)}（${gu.today.conversationCount} 会话）` : ''}`
        : '',
      quota?.currentModelQuota
        ? `- **当前模型配额**：${quota.currentModelQuota.label} 剩余 ${quota.currentModelQuota.remainingPercent.toFixed(1)}%`
        : '',
      h.process ? `- **活跃子进程**：PID ${h.process.pid} · CPU ${h.process.cpu}% · \`${h.process.command}\`` : '',
      cur.milestones ? `- **阶段进度**：${cur.milestones.done}/${cur.milestones.total}（${cur.milestones.percent}%）` : '',
      cur.compactHint?.needed ? `- **上下文建议**：${cur.compactHint.message}` : '',
    ].filter(Boolean).join('\n');

    if (await copyTextRobust(lines)) {
      showToast('诊断快照已复制');
    } else {
      showToast('复制失败，请稍后重试');
    }
  });

  pollOnce();
})();
