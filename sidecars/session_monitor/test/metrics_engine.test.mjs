import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateGeneratorRows,
  aggregateGlobalUsage,
  buildNetworkSnapshot,
  computeCacheHitRate,
  createEmptyTrafficLedger,
  decodeGeneratorMetadataRow,
  decodeStepCreatedAtMs,
  extractProxyPortsFromEnv,
  formatByteRate,
  formatBytes,
  identifyAntigravityPids,
  identifyProxyPids,
  localDateKey,
  normalizeTrafficLedger,
  parseNettopSockets,
  parseScutilProxyPorts,
  parseUserStatusQuota,
  resetTrafficLedger,
  sortProcessTrafficMap,
  updateTrafficLedger,
} from '../metrics_engine.mjs';

// ---------------------------------------------------------------------------
// Minimal Protobuf Encoder Helpers (Test-only, for constructing exact wire fixtures)
// ---------------------------------------------------------------------------

function encVarint(n) {
  let v = BigInt(n);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encTag(fn, wt) {
  return encVarint((fn << 3) | wt);
}

function encUintField(fn, val) {
  return Buffer.concat([encTag(fn, 0), encVarint(val)]);
}

function encFloatField(fn, val) {
  const b = Buffer.alloc(4);
  b.writeFloatLE(val, 0);
  return Buffer.concat([encTag(fn, 5), b]);
}

function encBytesField(fn, bufOrStr) {
  const payload = typeof bufOrStr === 'string' ? Buffer.from(bufOrStr, 'utf-8') : bufOrStr;
  return Buffer.concat([encTag(fn, 2), encVarint(payload.length), payload]);
}

function encDuration(sec, nanos) {
  return Buffer.concat([
    sec ? encUintField(1, sec) : Buffer.alloc(0),
    nanos ? encUintField(2, nanos) : Buffer.alloc(0),
  ]);
}

function buildGenMetadataRow({
  stepIndices = [],
  packedIndices = true,
  input = 0,
  output = 0,
  cacheWrite = 0,
  cacheRead = 0,
  thinkingOutput = 0,
  responseOutput = 0,
  ttftSec = 0,
  ttftNanos = 0,
  streamSec = 0,
  streamNanos = 0,
  retries = 0,
  modelCost = 0,
  creditCost = 0,
  modelDisplayName = '',
  responseModel = '',
  maxContextTokens = 0,
  estimatedTokensUsed = 0,
  breakdownGroups = [],
  promptBlobSize = 0,
} = {}) {
  const usage = Buffer.concat([
    encUintField(1, 1535),
    input ? encUintField(2, input) : Buffer.alloc(0),
    output ? encUintField(3, output) : Buffer.alloc(0),
    cacheWrite ? encUintField(4, cacheWrite) : Buffer.alloc(0),
    cacheRead ? encUintField(5, cacheRead) : Buffer.alloc(0),
    thinkingOutput ? encUintField(9, thinkingOutput) : Buffer.alloc(0),
    responseOutput ? encUintField(10, responseOutput) : Buffer.alloc(0),
  ]);

  let chatStartBuf = Buffer.alloc(0);
  if (maxContextTokens || estimatedTokensUsed || breakdownGroups.length) {
    let tbBuf = Buffer.alloc(0);
    if (breakdownGroups.length) {
      const gBufs = breakdownGroups.map((g) => encBytesField(
        1,
        Buffer.concat([encBytesField(1, g.name), encUintField(4, g.tokens)]),
      ));
      const total = breakdownGroups.reduce((s, g) => s + g.tokens, 0);
      tbBuf = encBytesField(3, Buffer.concat([...gBufs, encUintField(2, total)]));
    }
    const cwm = Buffer.concat([
      estimatedTokensUsed ? encUintField(1, estimatedTokensUsed) : Buffer.alloc(0),
      tbBuf,
      maxContextTokens ? encUintField(4, maxContextTokens) : Buffer.alloc(0),
    ]);
    // Include checkpoint_index = -1 (10-byte 64-bit negative varint sentinel seen in real Antigravity DBs)
    chatStartBuf = encBytesField(9, Buffer.concat([
      encUintField(2, -1),
      encBytesField(10, cwm),
    ]));
  }

  const chatModel = Buffer.concat([
    promptBlobSize > 0 ? encBytesField(1, Buffer.alloc(promptBlobSize, 0x41)) : Buffer.alloc(0),
    encBytesField(4, usage),
    modelCost > 0 ? encFloatField(5, modelCost) : Buffer.alloc(0),
    chatStartBuf,
    (ttftSec || ttftNanos) ? encBytesField(11, encDuration(ttftSec, ttftNanos)) : Buffer.alloc(0),
    (streamSec || streamNanos) ? encBytesField(12, encDuration(streamSec, streamNanos)) : Buffer.alloc(0),
    creditCost > 0 ? encUintField(13, creditCost) : Buffer.alloc(0),
    retries > 0 ? encUintField(14, retries) : Buffer.alloc(0),
    responseModel ? encBytesField(19, responseModel) : Buffer.alloc(0),
    modelDisplayName ? encBytesField(21, modelDisplayName) : Buffer.alloc(0),
  ]);

  const idxBuf = packedIndices && stepIndices.length
    ? encBytesField(2, Buffer.concat(stepIndices.map((idx) => encVarint(idx))))
    : Buffer.concat(stepIndices.map((idx) => encUintField(2, idx)));

  return Buffer.concat([
    encBytesField(1, chatModel),
    idxBuf,
    encBytesField(4, 'exec-id-test'),
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('computeCacheHitRate handles zero, 100%, Claude cache_write, and invalid inputs cleanly', () => {
  assert.equal(computeCacheHitRate(0, 0, 0), null);
  assert.equal(computeCacheHitRate(-50, 0, 0), null);
  assert.equal(computeCacheHitRate(NaN, undefined, null), null);
  assert.equal(computeCacheHitRate(0, 50000), 100);
  assert.equal(computeCacheHitRate(15000, 0), 0);
  assert.equal(computeCacheHitRate(2837, 173809), 98.4);
  // With Claude cache_write_tokens included in denominator: 8000 / (2000 + 8000 + 10000) = 40.0%
  assert.equal(computeCacheHitRate(2000, 8000, 10000), 40);
});

test('formatBytes and formatByteRate format edge values cleanly', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-10), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(200 * 1024), '200 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MB');
  assert.equal(formatBytes(180 * 1024 * 1024), '180.0 MB');
  assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024), '2.50 GB');

  assert.equal(formatByteRate(0), '0 B/s');
  assert.equal(formatByteRate(0.4), '0 B/s');
  assert.equal(formatByteRate(500), '500 B/s');
  assert.equal(formatByteRate(42 * 1024), '42.0 KB/s');
  assert.equal(formatByteRate(3.2 * 1024 * 1024), '3.20 MB/s');
});

test('decodeGeneratorMetadataRow and decodeStepCreatedAtMs parse real wire format including -1 varint sentinel and malformed buffers', () => {
  const rowBuf = buildGenMetadataRow({
    stepIndices: [68, 69],
    packedIndices: true,
    input: 2837,
    output: 641,
    cacheWrite: 1200,
    cacheRead: 173809,
    thinkingOutput: 80,
    responseOutput: 561,
    ttftSec: 4,
    ttftNanos: 888_161_375,
    streamSec: 3,
    streamNanos: 609_107_667,
    retries: 2,
    modelCost: 0.125,
    creditCost: 3,
    modelDisplayName: 'Gemini 4 Neon (XHigh)',
    responseModel: 'gemini-4-neon',
    maxContextTokens: 512000,
    estimatedTokensUsed: 156918,
    breakdownGroups: [
      { name: 'Chat Messages', tokens: 147591 },
      { name: 'Tools', tokens: 4115 },
      { name: 'Skills', tokens: 1543 },
      { name: 'Rules', tokens: 1295 },
      { name: 'System Prompt', tokens: 988 },
    ],
    promptBlobSize: 2048,
  });

  const dec = decodeGeneratorMetadataRow(rowBuf);
  assert.ok(dec);
  assert.deepEqual(dec.stepIndices, [68, 69]);
  assert.equal(dec.executionId, 'exec-id-test');
  assert.equal(dec.usage.input, 2837);
  assert.equal(dec.usage.output, 641);
  assert.equal(dec.usage.cacheWrite, 1200);
  assert.equal(dec.usage.cacheRead, 173809);
  assert.equal(dec.usage.thinkingOutput, 80);
  assert.equal(dec.usage.responseOutput, 561);
  assert.equal(dec.ttftMs, 4888);
  assert.equal(dec.streamMs, 3609);
  assert.equal(dec.retries, 2);
  assert.ok(Math.abs(dec.modelCost - 0.125) < 0.001);
  assert.equal(dec.creditCost, 3);
  assert.equal(dec.modelDisplayName, 'Gemini 4 Neon (XHigh)');
  assert.equal(dec.responseModel, 'gemini-4-neon');
  assert.equal(dec.storedPromptBytes, 2048);
  assert.equal(dec.contextWindow.maxContextTokens, 512000);
  assert.equal(dec.contextWindow.estimatedTokensUsed, 156918);
  assert.equal(dec.contextWindow.tokenBreakdown.groups.length, 5);

  // Unpacked step_indices
  const unpackedRow = decodeGeneratorMetadataRow(buildGenMetadataRow({
    stepIndices: [5, 6],
    packedIndices: false,
    input: 100,
    output: 50,
  }));
  assert.deepEqual(unpackedRow.stepIndices, [5, 6]);

  // Step timestamp decoding
  const tsSec = 1795108940;
  const stepMetaBuf = encBytesField(1, encDuration(tsSec, 391_321_000));
  assert.equal(decodeStepCreatedAtMs(stepMetaBuf), tsSec * 1000 + 391);
  assert.equal(decodeStepCreatedAtMs(encBytesField(1, encDuration(0, 0))), null);
  assert.equal(decodeStepCreatedAtMs(Buffer.from([0xff, 0xff, 0xff])), null);

  // Corrupted / empty buffers never throw
  assert.equal(decodeGeneratorMetadataRow(null), null);
  assert.equal(decodeGeneratorMetadataRow(Buffer.alloc(0)), null);
  assert.equal(decodeGeneratorMetadataRow(Buffer.from([0x0a, 0xff, 0xff, 0x01])), null);
});

test('aggregateGeneratorRows buckets by exact local date, filters reverted contextWindow by liveStepCount, and guards decodeTps', () => {
  const day1Ms = new Date(2026, 10, 19, 23, 50, 0).getTime();
  const day2Ms = new Date(2026, 10, 20, 0, 15, 0).getTime();
  const d1 = localDateKey(day1Ms);
  const d2 = localDateKey(day2Ms);

  const r1 = decodeGeneratorMetadataRow(buildGenMetadataRow({
    stepIndices: [1],
    input: 10000,
    cacheRead: 0,
    output: 400,
    thinkingOutput: 150,
    responseOutput: 250,
    ttftSec: 5,
    streamSec: 4,
    maxContextTokens: 512000,
    breakdownGroups: [{ name: 'Chat Messages', tokens: 8000 }, { name: 'Tools', tokens: 2000 }],
    modelDisplayName: 'Gemini 4 Neon (High)',
  }));
  const r2 = decodeGeneratorMetadataRow(buildGenMetadataRow({
    stepIndices: [3],
    input: 2000,
    cacheRead: 18000,
    output: 600,
    thinkingOutput: 200,
    responseOutput: 400,
    ttftSec: 3,
    streamSec: 6,
    retries: 1,
    maxContextTokens: 512000,
    breakdownGroups: [{ name: 'Chat Messages', tokens: 18000 }, { name: 'Tools', tokens: 2000 }],
    modelDisplayName: 'Gemini 4 Neon (High)',
  }));
  // Reverted call at step 10 (liveStepCount = 5): counts in cumulative totals, NOT active latest contextWindow
  const rReverted = decodeGeneratorMetadataRow(buildGenMetadataRow({
    stepIndices: [10],
    input: 5000,
    cacheRead: 5000,
    output: 100,
    ttftSec: 2,
    streamNanos: 10_000_000, // 10ms (<50ms guard -> excluded from decodeTps!)
    maxContextTokens: 999999,
    modelDisplayName: 'Reverted Model',
  }));

  const stepDates = new Map([[1, day1Ms], [3, day2Ms], [10, day2Ms]]);
  const agg = aggregateGeneratorRows([r1, r2, rReverted], stepDates, { liveStepCount: 5 });

  assert.equal(agg.totals.apiCalls, 3);
  assert.equal(agg.totals.input, 17000);
  assert.equal(agg.totals.cacheRead, 23000);
  assert.equal(agg.totals.output, 1100);
  assert.equal(agg.totals.thinkingOutput, 350);
  assert.equal(agg.totals.responseOutput, 650);
  assert.equal(agg.totals.hasThinkingBreakdown, true);
  assert.equal(agg.totals.cacheHitRate, 57.5); // 23000 / 40000
  assert.equal(agg.totals.retries, 1);
  // Decode TPS only sums r1 (400 in 4s) + r2 (600 in 6s) = 1000 / 10s = 100.0 t/s (rReverted 10ms excluded)
  assert.equal(agg.totals.decodeTps, 100.0);
  assert.equal(agg.totals.avgTtftMs, Math.round((5000 + 3000 + 2000) / 3));

  // Active latest comes from step 3, NOT reverted step 10
  assert.equal(agg.latest.maxContextTokens, 512000);
  assert.equal(agg.latest.cacheHitRate, 90.0);
  assert.equal(agg.latest.tokenBreakdown.items[0].label, '对话历史');

  // Date buckets separated cleanly
  assert.equal(agg.byDate[d1].apiCalls, 1);
  assert.equal(agg.byDate[d1].input, 10000);
  assert.equal(agg.byDate[d2].apiCalls, 2);
  assert.equal(agg.byDate[d2].cacheRead, 23000);

  // Per-step map populated for Timeline enrichment
  assert.equal(agg.byStepIndex[3].cacheHitRate, 90.0);
  assert.equal(agg.byStepIndex[3].ttftMs, 3000);
});

test('identifyAntigravityPids and parseNettopSockets separate external, local proxy, and loopback IPC accurately', () => {
  const psRows = [
    { pid: 3580, ppid: 1, command: '/Applications/Antigravity.app/Contents/MacOS/Antigravity' },
    { pid: 3633, ppid: 3580, command: '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --utility-sub-type=network.mojom.NetworkService' },
    { pid: 3981, ppid: 3580, command: '/Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone' },
    { pid: 4052, ppid: 3981, command: 'node /repo/sidecars/session_monitor/main.mjs' },
    { pid: 9999, ppid: 3981, command: 'curl https://example.com/big.iso' },
  ];
  const { agyPids, procLabels } = identifyAntigravityPids(psRows);
  assert.deepEqual([...agyPids].sort((a, b) => a - b), [3580, 3633, 3981]);
  assert.equal(procLabels.get(3981), 'language_server');
  assert.equal(procLabels.get(3633), 'Antigravity Network');

  const proxyPorts = extractProxyPortsFromEnv({ HTTPS_PROXY: 'http://127.0.0.1:7897', INVALID: 'not-a-url' });
  assert.equal(proxyPorts.has(7897), true);

  const sampleNettop = [
    ',interface,state,bytes_in,bytes_out,',
    'mihomo.888,,,1000,2000,',
    'tcp4 127.0.0.1:7890<->*:*,lo0,Listen,,,',
    'Antigravity Hel.3633,,,400000000,30000000,',
    'tcp4 127.0.0.1:58824<->127.0.0.1:56708,lo0,Established,400000000,30000000,',
    'language_server.3981,,,50000000,600000000,',
    'tcp4 127.0.0.1:56708<->*:*,lo0,Listen,,,',
    'tcp4 127.0.0.1:56708<->127.0.0.1:58824,lo0,Established,30000000,400000000,',
    'tcp4 192.168.0.130:50341<->198.18.0.18:443,en0,Established,500000,80000000,',
    'tcp4 127.0.0.1:51234<->127.0.0.1:7890,lo0,Established,200000,10000000,',
    'tcp6 ::1.51235<->::1.7897,lo0,Established,100000,5000000,',
    'curl.9999,,,999999999,1000,',
    'tcp4 192.168.0.130:55555<->93.184.216.34:443,en0,Established,999999999,1000,',
  ].join('\n');

  const parsed = parseNettopSockets(sampleNettop, agyPids, { procLabels, proxyPorts });
  // External must include en0 (500k/80M) + lo0->mihomo:7890 (200k/10M) + lo0->envProxy:7897 (100k/5M),
  // and MUST NOT include curl.9999 OR lo0 IPC between Helper.3633 and language_server:56708!
  assert.equal(parsed.liveExternal.in, 800_000);
  assert.equal(parsed.liveExternal.out, 95_000_000);
  assert.equal(parsed.liveExternal.count, 3);
  assert.equal(parsed.liveExternal.proxyCount, 2);
  // Loopback IPC client+server pair is deduplicated to 1 canonical bidirectional connection (total = 430MB, NOT 2x = 860MB!)
  assert.equal(parsed.liveLoopback.count, 1);
  assert.equal(parsed.liveLoopback.total, 430_000_000);
  assert.equal(parsed.byProcess.length, 1);
  assert.equal(parsed.byProcess[0].name, 'language_server');
});

test('nettop parser guards against IPv6 UDP header collision, handles empty-iface UDP external, scutil proxy ports, mDNS exclusion, and sidecar/ownPid exclusion', () => {
  const psRows = [
    { pid: 100, ppid: 1, command: '/Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm64 --standalone' },
    { pid: 101, ppid: 100, command: '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --import=file:///Users/u/.gemini/antigravity/lib/node_modules/sidecar_sdk/register_loader.js main.mjs' },
    { pid: 102, ppid: 100, command: '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --import=file:///Users/u/.gemini/antigravity/lib/node_modules/sidecar_sdk/register_loader.js other_plugin.mjs' },
    { pid: 103, ppid: 1, command: '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --type=utility --utility-sub-type=network.mojom.NetworkService' },
    { pid: 500, ppid: 1, command: 'node /usr/local/bin/whistle run -p 8899' },
  ];
  // Both ownPid=101 AND third-party UI plugin sidecar pid=102 MUST be excluded so only AGY host processes are counted
  const { agyPids, procLabels } = identifyAntigravityPids(psRows, { ownPid: 101 });
  assert.deepEqual([...agyPids].sort((a, b) => a - b), [100, 103]);
  assert.equal(procLabels.get(100), 'language_server');
  assert.equal(procLabels.get(103), 'Antigravity Network');

  const proxyPids = identifyProxyPids(psRows);
  assert.equal(proxyPids.has(500), true);

  const scutilSample = [
    '<dictionary> {',
    '  HTTPEnable : 1',
    '  HTTPPort : 6152',
    '  HTTPSEnable : 1',
    '  HTTPSPort : 6152',
    '  SOCKSEnable : 0',
    '  SOCKSPort : 6153',
    '}',
  ].join('\n');
  const sysPorts = parseScutilProxyPorts(scutilSample);
  assert.deepEqual([...sysPorts], [6152]);

  const trickyNettop = [
    ',interface,state,bytes_in,bytes_out,',
    'node.500,,,100,200,',
    'tcp4 127.0.0.1:8899<->*:*,lo0,Listen,,,',
    'language_server.100,,,50000,100000,',
    // IPv6 UDP line with empty iface + empty state that ends in .<digits>: MUST NOT hijack curPid!
    'udp6 ::1.5353<->ff02::fb.5353,,,100,200,',
    // LAN mDNS multicast on en0 MUST NOT be counted as AGY remote server traffic!
    'udp4 192.168.0.10:5353<->224.0.0.251:5353,en0,,4000,8000,',
    // Subsequent external sockets MUST still belong to language_server.100!
    'tcp4 127.0.0.1:52000<->127.0.0.1:8899,lo0,Established,5000,60000,',
    'tcp4 127.0.0.1:52001<->127.0.0.1:6152,lo0,Established,2000,10000,',
    // Empty-iface external UDP/QUIC socket
    'udp4 192.168.0.10:55000<->198.18.0.18:443,,,1500,30000,',
    // Wildcard empty-iface UDP socket with 0 bytes -> ignored
    'udp4 *:*<->*:*,,,0,0,',
  ].join('\n');

  const parsed = parseNettopSockets(trickyNettop, agyPids, { procLabels, proxyPorts: sysPorts, proxyPids });
  assert.equal(parsed.liveExternal.count, 3);
  assert.equal(parsed.liveExternal.proxyCount, 2);
  assert.equal(parsed.liveExternal.in, 8500);
  assert.equal(parsed.liveExternal.out, 100000);
  assert.equal(parsed.byProcess[0].name, 'language_server');
});

test('updateTrafficLedger tracks per-process cumulative today/allTime totals, upgrades v1 ledgers, and resets cleanly with freshSample', () => {
  const t1 = new Date(2026, 10, 19, 23, 59, 50).getTime();
  // Simulate upgrading a persisted v1 ledger
  const v1Raw = {
    version: 1,
    trackingSinceMs: t1 - 60000,
    lastSampleAtMs: t1 - 2000,
    allTime: { in: 100, out: 900, total: 1000 },
    today: { date: localDateKey(t1), in: 100, out: 900, total: 1000 },
    todayLoopback: { date: localDateKey(t1), in: 0, out: 0, total: 0 },
    lastSeenExternal: {},
    lastSeenLoopback: {},
  };
  let ledger = normalizeTrafficLedger(v1Raw, t1);
  assert.equal(ledger.version, 2);

  const sample1 = {
    externalSockets: [
      { key: '100|s1|en0', procName: 'language_server', in: 1000, out: 50000 },
      { key: '200|s2|en0', procName: 'Antigravity Network', in: 2000, out: 3000 },
    ],
    loopbackSockets: [],
  };
  ledger = updateTrafficLedger(ledger, sample1, t1).ledger;
  const todayProcs = sortProcessTrafficMap(ledger.todayByProcess.map);
  assert.equal(todayProcs.length, 2);
  assert.equal(todayProcs[0].name, 'language_server');
  assert.equal(todayProcs[0].out, 50000);
  assert.equal(todayProcs[1].name, 'Antigravity Network');

  // Midnight rollover clears todayByProcess while keeping allTimeByProcess
  const tNext = new Date(2026, 10, 20, 0, 0, 10).getTime();
  const sample2 = {
    externalSockets: [
      { key: '100|s1|en0', procName: 'language_server', in: 1500, out: 60000 },
    ],
    loopbackSockets: [],
  };
  ledger = updateTrafficLedger(ledger, sample2, tNext).ledger;
  assert.equal(sortProcessTrafficMap(ledger.todayByProcess.map).length, 1);
  assert.equal(ledger.todayByProcess.map.language_server.out, 10000);
  assert.equal(ledger.allTimeByProcess.language_server.out, 60000);
  assert.equal(ledger.allTimeByProcess['Antigravity Network'].out, 3000);

  // Reset with freshSample zeroes both per-process maps AND adopts freshSample's higher socket watermarks!
  const freshAtReset = {
    externalSockets: [{ key: '100|s1|en0', procName: 'language_server', in: 2000, out: 90000 }],
    loopbackSockets: [],
  };
  const reset = resetTrafficLedger(ledger, tNext + 2000, freshAtReset);
  assert.deepEqual(sortProcessTrafficMap(reset.todayByProcess.map), []);
  assert.deepEqual(sortProcessTrafficMap(reset.allTimeByProcess), []);
  // Next poll with same freshAtReset adds 0 bytes!
  const afterReset = updateTrafficLedger(reset, freshAtReset, tNext + 4000);
  assert.equal(afterReset.deltaOut, 0);
  assert.equal(afterReset.ledger.today.total, 0);
});

test('updateTrafficLedger and resetTrafficLedger preserve closed-socket totals, prevent restart double-counting, handle midnight rollover and reset baseline', () => {
  const t1 = new Date(2026, 10, 19, 23, 59, 50).getTime();
  let ledger = createEmptyTrafficLedger(t1);

  // Sample 1: two open sockets already have 10MB out + 1MB in
  const s1 = {
    externalSockets: [
      { key: '3981|sockA|en0', in: 600_000, out: 6_000_000 },
      { key: '3981|sockB|en0', in: 400_000, out: 4_000_000 },
    ],
    loopbackSockets: [],
  };
  let u = updateTrafficLedger(ledger, s1, t1);
  ledger = u.ledger;
  assert.equal(ledger.allTime.out, 10_000_000);
  assert.equal(ledger.allTime.in, 1_000_000);
  assert.equal(ledger.rates.outBps, 0); // First sample has no prior timestamp -> no fake spike

  // Sample 2 (+2s): sockA grows by +2MB out, sockB CLOSES (disappears!)
  const t2 = t1 + 2000;
  const s2 = {
    externalSockets: [
      { key: '3981|sockA|en0', in: 700_000, out: 8_000_000 },
    ],
    loopbackSockets: [],
  };
  u = updateTrafficLedger(ledger, s2, t2);
  ledger = u.ledger;
  assert.equal(u.deltaOut, 2_000_000);
  assert.equal(u.deltaIn, 100_000);
  // sockB's 4MB is PRESERVED! Total = 10MB + 2MB = 12MB
  assert.equal(ledger.allTime.out, 12_000_000);
  assert.equal(ledger.today.out, 12_000_000);
  assert.equal(ledger.rates.outBps, 1_000_000); // 2MB / 2s = 1MB/s

  // Sidecar restart simulation: serialize -> deserialize -> same open sockA does NOT double-count!
  const reloaded = normalizeTrafficLedger(JSON.parse(JSON.stringify(ledger)), t2 + 1000);
  u = updateTrafficLedger(reloaded, s2, t2 + 2000);
  ledger = u.ledger;
  assert.equal(u.deltaOut, 0);
  assert.equal(ledger.allTime.out, 12_000_000);

  // Midnight rollover (+20s into 2026-11-20): sockA grows +500KB out -> today resets to 500KB, allTime = 12.5MB
  const tNextDay = new Date(2026, 10, 20, 0, 0, 10).getTime();
  u = updateTrafficLedger(ledger, {
    externalSockets: [{ key: '3981|sockA|en0', in: 750_000, out: 8_500_000 }],
    loopbackSockets: [],
  }, tNextDay);
  ledger = u.ledger;
  assert.equal(ledger.today.date, localDateKey(tNextDay));
  assert.equal(ledger.today.out, 500_000);
  assert.equal(ledger.allTime.out, 12_500_000);

  // Ephemeral port reuse: same key resets counter from 8.5MB down to 120KB -> counts 120KB as new connection!
  u = updateTrafficLedger(ledger, {
    externalSockets: [{ key: '3981|sockA|en0', in: 10_000, out: 120_000 }],
    loopbackSockets: [],
  }, tNextDay + 2000);
  ledger = u.ledger;
  assert.equal(u.deltaOut, 120_000);
  assert.equal(ledger.today.out, 620_000);

  // Reset ledger: zeroes counters while preserving sockA high-water mark so next unchanged poll adds 0!
  const reset = resetTrafficLedger(ledger, tNextDay + 3000);
  assert.equal(reset.allTime.total, 0);
  assert.equal(reset.today.total, 0);
  const afterResetSame = updateTrafficLedger(reset, {
    externalSockets: [{ key: '3981|sockA|en0', in: 10_000, out: 120_000 }],
    loopbackSockets: [],
  }, tNextDay + 5000);
  assert.equal(afterResetSame.ledger.allTime.total, 0);

  // Then +50KB new traffic adds ONLY 50KB!
  const afterResetNew = updateTrafficLedger(afterResetSame.ledger, {
    externalSockets: [{ key: '3981|sockA|en0', in: 15_000, out: 170_000 }],
    loopbackSockets: [],
  }, tNextDay + 7000);
  assert.equal(afterResetNew.ledger.allTime.out, 50_000);
  assert.equal(afterResetNew.ledger.allTime.in, 5_000);
});

test('parseUserStatusQuota deduplicates model quota buckets and matches localized current model name', () => {
  const sample = {
    userStatus: {
      planStatus: {
        planInfo: { planName: 'Pro', monthlyPromptCredits: 50000, monthlyFlowCredits: 150000 },
        availablePromptCredits: 500,
        availableFlowCredits: 100,
      },
      cascadeModelConfigData: {
        clientModelConfigs: [
          { label: 'Gemini 4 Neon (High)', quotaInfo: { remainingFraction: 0.8448, resetTime: '2026-11-19T19:19:57Z' } },
          { label: 'Gemini 4 Neon (XHigh)', quotaInfo: { remainingFraction: 0.8448, resetTime: '2026-11-19T19:19:57Z' } },
          { label: 'Gemini 3.8 Flash (High)', quotaInfo: { remainingFraction: 0.8448, resetTime: '2026-11-19T19:19:57Z' } },
          { label: 'Claude Opus 5.5 (High)', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-19T22:28:23Z' } },
          { label: 'GPT-OSS 120B (Medium)', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-19T22:28:23Z' } },
        ],
      },
    },
  };

  const q = parseUserStatusQuota(sample, 'Gemini 4 Neon（极高推理）');
  assert.ok(q);
  assert.equal(q.planName, 'Pro');
  assert.equal(q.credits.availablePrompt, 500);
  assert.equal(q.groups.length, 2);
  assert.equal(q.groups[0].remainingPercent, 84.5);
  assert.equal(q.groups[0].modelsCount, 3);
  assert.match(q.groups[0].label, /Gemini 4/);
  assert.equal(q.groups[1].remainingPercent, 100);
  assert.equal(q.currentModelQuota.label, 'Gemini 4 Neon (XHigh)');
  assert.equal(q.currentModelQuota.remainingPercent, 84.5);

  assert.equal(parseUserStatusQuota(null), null);
  assert.equal(parseUserStatusQuota({ userStatus: {} }), null);

  // Proto3 omits remainingFraction when exhausted (0.0), leaving only resetTime; userTier.name takes precedence; slug matches hyphenated modelId
  const exhaustedSample = {
    userStatus: {
      userTier: { name: 'Google AI Ultra' },
      planStatus: { planInfo: { planName: 'Pro' }, availableFlexCredits: 250 },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 4 Neon (XHigh)',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M535' },
            quotaInfo: { resetTime: '2026-11-20T05:00:00Z' },
          },
          {
            label: 'Claude Opus 5.5 (High)',
            quotaInfo: { remainingFraction: 0.5, resetTime: '2026-11-20T06:00:00Z' },
          },
        ],
      },
    },
  };
  const qe = parseUserStatusQuota(exhaustedSample, 'gemini-4-neon-xhigh');
  assert.ok(qe);
  assert.equal(qe.planName, 'Google AI Ultra');
  assert.equal(qe.credits.availableFlex, 250);
  assert.equal(qe.groups.length, 2);
  assert.equal(qe.groups[0].remainingPercent, 0);
  assert.equal(qe.currentModelQuota.label, 'Gemini 4 Neon (XHigh)');
  assert.equal(qe.currentModelQuota.remainingPercent, 0);
});

test('aggregateGeneratorRows localizes Subagents/Plugins/Mcp Tools, preserves storedPromptBytes, and rejects negative duration varints', () => {
  const rowWithExtraGroups = decodeGeneratorMetadataRow(buildGenMetadataRow({
    stepIndices: [1],
    input: 1000,
    cacheRead: 9000,
    output: 200,
    ttftSec: -1, // negative 64-bit varint -> must become null, NOT 0ms!
    streamSec: 2,
    modelCost: 0.05,
    creditCost: 2,
    promptBlobSize: 65536,
    breakdownGroups: [
      { name: 'Chat Messages', tokens: 5000 },
      { name: 'Plugins', tokens: 1200 },
      { name: 'Subagents', tokens: 800 },
      { name: 'Mcp Tools', tokens: 600 },
    ],
  }));
  assert.equal(rowWithExtraGroups.ttftMs, null);
  const d1Ms = new Date(2026, 10, 18, 12, 0, 0).getTime();
  // Second row is reverted (step 99 missing from stepDates) -> must inherit d1Ms instead of falling back to today!
  const orphanRow = decodeGeneratorMetadataRow(buildGenMetadataRow({
    stepIndices: [99],
    input: 500,
    cacheRead: 500,
    output: 50,
  }));
  const agg = aggregateGeneratorRows([rowWithExtraGroups, orphanRow], new Map([[1, d1Ms]]), {
    liveStepCount: 5,
    fallbackDateKey: '2026-11-20',
  });
  const labels = agg.latest.tokenBreakdown.items.map((x) => x.label);
  assert.deepEqual(labels, ['对话历史', '插件', '子代理', 'MCP 工具']);
  assert.equal(agg.latest.storedPromptBytes, 65536);
  const d1Key = localDateKey(d1Ms);
  assert.equal(agg.byDate[d1Key].apiCalls, 2);
  assert.equal(agg.byDate[d1Key].modelCost, 0.05);
  assert.equal(agg.byDate[d1Key].creditCost, 2);
  assert.equal(agg.byDate['2026-11-20'], undefined);
});

test('buildNetworkSnapshot reconciles unattributed v1 bytes, tracks allTimeLoopback, and decays stale rates', () => {
  const t1 = new Date(2026, 10, 20, 10, 0, 0).getTime();
  const v1Upgraded = {
    version: 2,
    trackingSinceMs: t1 - 600_000,
    lastSampleAtMs: t1 - 2_000,
    allTime: { in: 1000, out: 9000, total: 10000 },
    today: { date: localDateKey(t1), in: 1000, out: 9000, total: 10000 },
    todayLoopback: { date: localDateKey(t1), in: 500, out: 1500, total: 2000 },
    allTimeByProcess: { language_server: { in: 400, out: 3600, total: 4000 } },
    todayByProcess: { date: localDateKey(t1), map: { language_server: { in: 400, out: 3600, total: 4000 } } },
    rates: { inBps: 1024, outBps: 20480, totalBps: 21504 },
    lastSeenExternal: {},
    lastSeenLoopback: {},
  };

  // Fresh sample (<15s old): keeps live rate, reconciles missing 6000 B into '历史未分进程', seeds allTimeLoopback
  const freshSnap = buildNetworkSnapshot(v1Upgraded, null, t1, { available: true });
  assert.equal(freshSnap.rates.outBps, 20480);
  assert.equal(freshSnap.allTimeLoopback.total, 2000);
  assert.equal(freshSnap.todayByProcess.reduce((s, p) => s + p.total, 0), 10000);
  assert.equal(freshSnap.todayByProcess[0].name, '历史未分进程');
  assert.equal(freshSnap.todayByProcess[0].total, 6000);

  // Stale sample (>15s old): decays live rate to 0 B/s
  const staleSnap = buildNetworkSnapshot(v1Upgraded, null, t1 + 20_000, { available: true });
  assert.deepEqual(staleSnap.rates, { inBps: 0, outBps: 0, totalBps: 0 });
});

test('aggregateGlobalUsage aggregates global & today TTFT, decodeTps, and costs, and parseUserStatusQuota matches cfg.modelId', () => {
  const today = '2026-11-20';
  const entries = [
    {
      appData: '/tmp',
      convId: 'conv-1',
      totals: {
        apiCalls: 2,
        input: 1000,
        cacheRead: 9000,
        cacheWrite: 0,
        output: 500,
        thinkingOutput: 200,
        responseOutput: 300,
        hasThinkingBreakdown: true,
        retries: 1,
        modelCost: 0.12,
        creditCost: 4,
        ttftSumMs: 4000,
        ttftCount: 2,
        maxTtftMs: 2500,
        streamSumMs: 5000,
        streamCount: 2,
        streamOutTokens: 500,
      },
      byDate: {
        [today]: {
          apiCalls: 1,
          input: 500,
          cacheRead: 4500,
          cacheWrite: 0,
          output: 250,
          thinkingOutput: 100,
          responseOutput: 150,
          retries: 1,
          modelCost: 0.06,
          creditCost: 2,
          ttftSumMs: 2500,
          ttftCount: 1,
          maxTtftMs: 2500,
          streamSumMs: 2500,
          streamCount: 1,
          streamOutTokens: 250,
        },
      },
    },
  ];
  const agg = aggregateGlobalUsage(entries, today);
  assert.equal(agg.allTime.avgTtftMs, 2000);
  assert.equal(agg.allTime.maxTtftMs, 2500);
  assert.equal(agg.allTime.decodeTps, 100);
  assert.equal(agg.allTime.modelCost, 0.12);
  assert.equal(agg.allTime.creditCost, 4);
  assert.equal(agg.today.avgTtftMs, 2500);
  assert.equal(agg.today.decodeTps, 100);
  assert.equal(agg.today.creditCost, 2);

  // parseUserStatusQuota matches explicit cfg.modelId and candidate arrays (displayName + responseModel)
  const quotaRaw = {
    userStatus: {
      userTier: { name: 'Google AI Ultra' },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Friendly Display Alias',
            modelId: 'gemini-4-neon-xhigh',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M535' },
            quotaInfo: { remainingFraction: 0.62, resetTime: '2026-11-20T05:00:00Z' },
          },
        ],
      },
    },
  };
  const q1 = parseUserStatusQuota(quotaRaw, ['Unmatched Title', 'gemini-4-neon-xhigh']);
  assert.equal(q1.currentModelQuota.label, 'Friendly Display Alias');
  assert.equal(q1.currentModelQuota.remainingPercent, 62);
  const q2 = parseUserStatusQuota(quotaRaw, 'gemini-4-neon');
  assert.equal(q2.currentModelQuota.label, 'Friendly Display Alias');
});
