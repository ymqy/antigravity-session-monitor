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
    etag: '',
    uiBuildKey: '',
    serverClockSkewMs: 0,
    snap: null,
    settings: null,
    tab: 'overview',
    tlFilter: 'all',
    drawerSettingsOpen: false,
    nudgeOpen: false,
    prevHealthState: '',
    autoExpandedAlertKey: '',
    msExpandedOverride: null, // null = 自动（<100% 展开，100% 收起），boolean = 用户手动切换
    lastMsConvKey: '',
    idleSessionsExpanded: false,
    compactingConvId: '',
    compactingBaselineCount: 0,
    compactingUntilMs: 0,
  };

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
    if (!ts || ts.latestTps == null) return '等待首轮模型生成完成后计算生成速度';
    return [
      `最新一轮：${ts.latestTps.toFixed(1)} t/s${ts.latestOutTokens ? `（${ts.latestOutTokens.toLocaleString()} t / ${ts.latestGenSec ?? '?'}s）` : ''}`,
      ts.avgTps != null ? `任务均值：${ts.avgTps.toFixed(1)} t/s` : '',
      ts.peakTps != null ? `历史峰值：${ts.peakTps.toFixed(1)} t/s` : '',
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
    return state.overrideConvId || hostConvId();
  }

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

    // 1. 顶栏信息
    if (cur.workspaceName) {
      $('ws-tag').textContent = cur.workspaceName;
      $('ws-tag').classList.remove('hidden');
    } else {
      $('ws-tag').classList.add('hidden');
    }

    const ownId = hostConvId();
    const showingOther = Boolean(state.overrideConvId && ownId && state.overrideConvId !== ownId);
    $('btn-back-own').classList.toggle('hidden', !showingOther);

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

    if (sp.latestTps != null) {
      tpsEl.textContent = `${sp.latestTps.toFixed(1)} t/s`;
      tpsEl.classList.toggle('is-live-speed', isLive);
      tpsSubEl.textContent = sp.avgTps != null ? `均值 ${sp.avgTps.toFixed(1)} t/s` : `峰值 ${(sp.peakTps ?? sp.latestTps).toFixed(1)} t/s`;
    } else if (h.state === 'THINKING' || h.state === 'THINKING_DEEP') {
      tpsEl.textContent = '测速中…';
      tpsEl.classList.add('is-live-speed');
      tpsSubEl.textContent = '等待首轮落盘';
    } else {
      tpsEl.textContent = '—';
      tpsEl.classList.remove('is-live-speed');
      tpsSubEl.textContent = '暂无生成';
    }

    const roundsCount = h.invocationNum || cur.totalRounds || 0;
    const compactCount = cur.compactCount || 0;
    $('metric-steps').textContent = roundsCount > 0
      ? `${roundsCount} 轮 · ${cur.stepCount || 0} 步`
      : `${cur.stepCount || 0} 步`;
    $('metric-steps-box').title = compactCount > 0
      ? `累计 ${cur.stepCount || 0} 步 · 已压缩 ${compactCount} 次`
      : `累计 ${cur.stepCount || 0} 步`;

    const tok = cur.tokens || {};
    $('metric-ctx').textContent = fmtTokens(tok.currentContext || 0);
    $('metric-out').textContent = `输出 ${fmtTokens(tok.grandTotalOutput || tok.output || 0)}`;
    $('metric-tok-box').title = [
      `当前上下文窗口占用：${(tok.currentContext || 0).toLocaleString()} t（~26万 t 触发自动压缩）`,
      `累计输入：${(tok.input || 0).toLocaleString()} t`,
      `缓存命中：${(tok.cache || 0).toLocaleString()} t`,
      `主会话输出：${(tok.output || 0).toLocaleString()} t`,
      tok.subagentOutput ? `子代理输出：${tok.subagentOutput.toLocaleString()} t` : '',
    ].filter(Boolean).join('\n');

    // 检查手动触发的压缩是否已经落盘完成（CHECKPOINT 计数增加）
    if (
      state.compactingConvId
      && state.compactingConvId === cur.conversationId
      && compactCount > state.compactingBaselineCount
    ) {
      state.compactingConvId = '';
      state.compactingUntilMs = 0;
      showToast('上下文压缩已完成');
    } else if (state.compactingConvId && Date.now() > state.compactingUntilMs) {
      state.compactingConvId = '';
      state.compactingUntilMs = 0;
    }

    // 轻量压缩操作角标（核心指标：当前上下文 Token 占用量；手动点击直接触发压缩，绝不后台自动代执行）
    const ch = cur.compactHint;
    const compactBadge = $('compact-badge');
    const isCompactingHere = Boolean(
      state.compactingConvId && state.compactingConvId === cur.conversationId && Date.now() <= state.compactingUntilMs,
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
        const tpsText = sSp.latestTps != null
          ? `<span class="row-tps ${s.isRunning ? '' : 'idle'}" title="${esc(formatTpsTooltip(sSp))}">${sSp.latestTps.toFixed(1)} t/s</span>`
          : (s.isRunning ? '<span class="row-tps idle">测速中…</span>' : '');
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
              <span class="flat-row-title">${esc(b.description)}</span>
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

    // 6. 执行轨迹页签
    renderTimeline(cur.rounds || [], cur.totalRounds || 0);

    tickLiveClocks();
  }

  function buildFlatSessionRow(s) {
    const sDot = dotClassFor(s.state, s.severity);
    const sp = s.tokenSpeed || {};
    const tpsHtml = sp.latestTps != null
      ? `<span class="row-tps ${s.isActive ? '' : 'idle'}" title="${esc(formatTpsTooltip(sp))}">${sp.latestTps.toFixed(1)} t/s</span>`
      : (s.isActive ? '<span class="row-tps idle">测速中…</span>' : '<span class="row-tps idle">—</span>');

    const subParts = [s.badge];
    if (s.milestoneLabel) subParts.push(`阶段 ${s.milestoneLabel}`);
    if (sp.avgTps != null) subParts.push(`均值 ${sp.avgTps.toFixed(1)} t/s`);
    if (s.compactHint?.needed) subParts.push(s.compactHint.label || '建议压缩');
    if (s.isActive && s.headline) subParts.push(s.headline);

    return `
      <div class="flat-row interactive js-pick-session" data-conv="${esc(s.conversationId)}">
        <div class="flat-row-top">
          <div class="flat-row-left">
            <span class="pulse-dot sm ${sDot}"></span>
            ${s.workspaceName ? `<span class="flat-row-ws">${esc(s.workspaceName)}</span>` : ''}
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
        return `
          <article class="tl-card is-compact">
            <div class="tl-head">
              <span>#${esc(r.stepIndex)} · 上下文压缩</span>
              <span class="tabular">${esc(fmtTimeOfDay(r.startedAtMs))}</span>
            </div>
            <div class="tl-title">${esc(r.title)}</div>
          </article>
        `;
      }

      const tpsStr = r.tps != null ? `${r.tps.toFixed(1)} t/s` : '';
      const thinkStr = r.thinkingMs != null ? `思考 ${fmtShortDur(r.thinkingMs / 1000)}` : '';
      const toolsStr = r.toolsMs != null ? `工具 ${fmtShortDur(r.toolsMs / 1000)}` : '';
      const durMeta = [tpsStr, thinkStr, toolsStr].filter(Boolean).join(' · ') || fmtTimeOfDay(r.startedAtMs);

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
    const isLive = LIVE_STATES.has(h.state);

    // 右上角秒表仅在实时运行态显示，已结束时隐藏（避免与下方“本轮耗时”重复）
    if (isLive && h.startedAtMs) {
      const liveStepSec = Math.max(0, Math.floor((estServerNow - h.startedAtMs) / 1000));
      $('hero-timer').textContent = fmtClockTimer(liveStepSec);
      $('hero-timer').classList.remove('hidden');
    } else {
      $('hero-timer').classList.add('hidden');
    }

    if (isLive && h.turnStartedAtMs) {
      const liveTurnSec = Math.max(0, Math.floor((estServerNow - h.turnStartedAtMs) / 1000));
      $('metric-dur').textContent = fmtShortDur(liveTurnSec);
    } else {
      $('metric-dur').textContent = fmtShortDur(h.totalTurnSec || 0);
    }
  }
  setInterval(tickLiveClocks, 1000);

  // ---------- 轮询循环 ----------
  let pollTimer = null;
  async function pollOnce() {
    const targetConv = activeTargetConvId();
    try {
      const qs = new URLSearchParams();
      if (targetConv) qs.set('conversationId', targetConv);
      if (state.etag) qs.set('etag', state.etag);

      const data = await apiGet(`/api/state?${qs.toString()}`);
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
      const curState = state.snap?.current?.health?.state || 'IDLE';
      const nextDelay = LIVE_STATES.has(curState) ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      clearTimeout(pollTimer);
      pollTimer = setTimeout(pollOnce, nextDelay);
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
  document.querySelectorAll('.seg-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      document.querySelectorAll('.seg-tab').forEach((b) => {
        const active = b.dataset.tab === state.tab;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', String(active));
      });
      $('view-overview').classList.toggle('active', state.tab === 'overview');
      $('view-timeline').classList.toggle('active', state.tab === 'timeline');
    });
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
      if (cid && window.sidecar?.ui?.toggleConversation) {
        window.sidecar.ui.toggleConversation(cid);
      }
      return;
    }
    const row = e.target.closest('.js-pick-session');
    if (row) {
      state.overrideConvId = row.dataset.conv || '';
      state.etag = '';
      pollOnce();
    }
  };

  $('parallel-active-list').addEventListener('click', handleSessionRowClick);
  $('parallel-idle-list').addEventListener('click', handleSessionRowClick);

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

    state.compactingConvId = cid || cur.conversationId || '';
    state.compactingBaselineCount = cur.compactCount || 0;
    state.compactingUntilMs = Date.now() + 45_000;
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
        showToast(res.alreadyCompacting ? '当前会话正在压缩中' : '已触发上下文压缩（约 15～30s 完成）');
      } else {
        state.compactingConvId = '';
        state.compactingUntilMs = 0;
        renderAll();
        showToast(res?.reason || '触发压缩失败');
      }
    } catch (err) {
      state.compactingConvId = '';
      state.compactingUntilMs = 0;
      renderAll();
      showToast(`触发失败：${err.message || '网络异常'}`);
    }
  });

  $('btn-copy-diag').addEventListener('click', async () => {
    const cur = state.snap?.current;
    const h = cur?.health;
    if (!cur || !h) return;
    const sp = cur.tokenSpeed || {};
    const lines = [
      `### Antigravity 会话监控 · 诊断快照`,
      `- **会话编号**：\`${cur.conversationId || '未关联'}\``,
      `- **会话主题**：${cur.title || '未命名'}`,
      `- **当前状态**：${h.badge}`,
      `- **当前动作**：${h.headline}`,
      h.detail ? `- **补充详情**：${h.detail}` : '',
      sp.latestTps != null
        ? `- **生成速度**：最新 ${sp.latestTps.toFixed(1)} t/s（均值 ${(sp.avgTps ?? sp.latestTps).toFixed(1)} t/s · 峰值 ${(sp.peakTps ?? sp.latestTps).toFixed(1)} t/s）`
        : '',
      `- **本轮耗时**：${$('metric-dur').textContent}（累计 ${cur.stepCount || 0} 步）`,
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
