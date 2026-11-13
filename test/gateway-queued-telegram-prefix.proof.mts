/** Source-only row2 diagnostic. Run from an isolated, built, exact-pinned repo.
 * No product internals are mocked. The only doubles are loopback provider/Bot API.
 * Uses the ordinary default sessions_send operation, not passive mode=notify.
 * No fallback changes send mode or scheduler if the original route is refused.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

async function main() {
const repo = path.resolve(process.env.ROW2_REPO ?? process.cwd());
const expected = process.env.ROW2_EXPECT_SHA ?? '74fe09926ab5e4d12f6248d533338ff4c9f1f04e';
const out = path.resolve(process.env.ROW2_EVIDENCE ?? 'row2-runtime-evidence');
mkdirSync(out, { recursive: true });
mkdirSync(path.join(out, 'workspace'), { recursive: true });
const artifactErrors: string[] = [];
const artifact = (name: string, write: () => void) => { try { write(); } catch (error) { artifactErrors.push(`${name}: ${String(error)}`); } };
const writeEvidence = (name: string, value: string | Buffer) => artifact(name, () => writeFileSync(path.join(out, name), value));
const save = (name: string, value: unknown) => writeEvidence(name, JSON.stringify(value, null, 2) + '\n');
const trace = (kind: string, value: unknown) => artifact('timeline.jsonl', () => appendFileSync(path.join(out, 'timeline.jsonl'), JSON.stringify({ at: Date.now(), kind, value }) + '\n'));
const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(actual, expected, 'not the explicitly pinned source checkout');
readFileSync(path.join(repo, 'dist', 'index.js')); // fail before launch if not built
save('source.json', { actual, expected, fixture: import.meta.url, scope: 'synthetic loopback transport; no paid inference or live Telegram' });
const load = (relative: string) => import(pathToFileURL(path.join(repo, relative)).href);
const { createQaGatewayChild, isInternalRuntimeContextCarrierText } = await load('extensions/qa-lab/api.ts');
const { createTelegramApi, telegramProofChannel, telegramGatewayOptions } = await load('test/e2e/qa-lab/runtime/telegram-gateway.test-support.ts');
const { writeOpenAiResponsesText, writeOpenAiResponsesSse } = await load('test/helpers/openai-responses-sse.ts');

const M = { seed: 'ROW2-SEED', hold: 'ROW2-INCUMBENT-HOLD', queued: 'ROW2-QUEUED-TELEGRAM', notify: 'ROW2-INTERSESSION-NOTIFY', sender: 'ROW2-SEND-NOTIFY', control: 'ROW2-APPEND-CONTROL' };
const BOT_TOKEN = '424242:' + 'A'.repeat(35);
const CHAT_ID = -1002468135790;
const chat = { id: CHAT_ID, type: 'supergroup', title: 'Row2 isolated proof', is_forum: false };
const api = createTelegramApi({ token: BOT_TOKEN, bot: { id: 424242, is_bot: true, first_name: 'Row2', username: 'row2_proof_bot' }, chat });
const providerRequests: Array<{ sequence: number; at: number; kind: string; raw: string; body: any }> = [];
const providerErrors: string[] = [];
let targetKey: string | undefined;
let held: ServerResponse | undefined;
let heldSequence: number | undefined;
let senderReceipt: any;
let updateId = 0;
let telegramResponseSequence = 0;
let stage = 'startup';
let gateway: any;
let verdict: any = { outcome: 'setup_error' };
const owner = createQaGatewayChild();

function captureResponse(response: ServerResponse, name: string) {
  const chunks: Buffer[] = [];
  const originalWrite = response.write.bind(response);
  const originalEnd = response.end.bind(response);
  response.write = function(chunk: any, ...args: any[]) {
    if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return originalWrite(chunk, ...args);
  } as typeof response.write;
  response.end = function(chunk?: any, ...args: any[]) {
    if (chunk !== undefined && typeof chunk !== 'function') chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return originalEnd(chunk, ...args);
  } as typeof response.end;
  response.once('finish', () => {
    writeEvidence(name + '.response', Buffer.concat(chunks));
    save(name + '.http.json', { status: response.statusCode, headers: response.getHeaders() });
  });
}
function userText(body: any) {
  return (body.input ?? []).filter((item: any) => item.role === 'user').map((item: any) => typeof item.content === 'string' ? item.content : (item.content ?? []).map((part: any) => part.text ?? '').join('\n')).findLast((text: string) => !isInternalRuntimeContextCarrierText(text)) ?? '';
}
function reply(response: ServerResponse, sequence: number, text: string) {
  writeOpenAiResponsesText(response, { text, messageId: `msg_row2_${sequence}`, responseId: `resp_row2_${sequence}` });
}
function releaseHold() {
  if (held) { const response = held; held = undefined; trace('release-incumbent', heldSequence); reply(response, heldSequence!, 'ROW2-INCUMBENT-DONE'); }
}
const provider = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    if (request.method === 'GET' && request.url === '/v1/models') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'qa-row2', object: 'model' }] })); return; }
    if (request.method !== 'POST' || request.url !== '/v1/responses') throw new Error(`unexpected provider route ${request.method} ${request.url}`);
    const body = JSON.parse(raw);
    const current = userText(body);
    const title = JSON.stringify((body.input ?? []).filter((item: any) => ['developer', 'system'].includes(item.role))).includes('Generate a concise session title');
    const auxiliary = /Agent-to-agent (reply|announce) step/.test(current);
    const kind = title ? 'title' : auxiliary ? 'auxiliary' : current.includes(M.sender) ? 'sender' : current.includes(M.control) ? 'control' : current.includes(M.queued) ? 'queued' : current.includes(M.notify) ? 'notify' : current.includes(M.hold) ? 'incumbent' : current.includes(M.seed) ? 'seed' : 'unclassified';
    const sequence = providerRequests.length + 1;
    providerRequests.push({ sequence, at: Date.now(), kind, raw, body });
    writeEvidence(`provider-${sequence}.request.json`, raw);
    save(`provider-${sequence}.request-http.json`, { method: request.method, url: request.url, sessionId: request.headers.session_id, affinity: request.headers['x-session-affinity'] });
    captureResponse(response, `provider-${sequence}`);
    trace('provider-request', { sequence, kind });
    if (title) { reply(response, sequence, 'Row2 diagnostic'); return; }
    if (auxiliary) { reply(response, sequence, current.includes('reply step') ? 'REPLY_SKIP' : 'ANNOUNCE_SKIP'); return; }
    if (kind === 'sender') {
      const result = (body.input ?? []).find((item: any) => item.type === 'function_call_output' && item.call_id === 'call_row2_notify');
      if (result) { senderReceipt = JSON.parse(result.output); save('sessions-send-receipt.json', senderReceipt); reply(response, sequence, 'ROW2-NOTIFY-SUBMITTED'); return; }
      assert.ok(targetKey, 'target session was not discovered before sender start');
      const item = { type: 'function_call', id: 'fc_row2_notify', call_id: 'call_row2_notify', name: 'sessions_send', arguments: JSON.stringify({ sessionKey: targetKey, message: M.notify, timeoutSeconds: 0 }) };
      writeOpenAiResponsesSse(response, [{ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: `resp_row2_${sequence}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]);
      return;
    }
    if (kind === 'incumbent') { assert.equal(held, undefined, 'unexpected second held request'); held = response; heldSequence = sequence; trace('incumbent-held', sequence); return; }
    if (!['seed', 'queued', 'notify', 'control'].includes(kind)) throw new Error('unclassified provider request: fixture setup cannot infer the actual turn');
    reply(response, sequence, `ROW2-REPLIED-${kind.toUpperCase()}`);
  })().catch((error: unknown) => {
    providerErrors.push(String(error)); trace('provider-error', String(error));
    if (!response.headersSent) response.writeHead(500); response.end(String(error));
  });
});
const telegram = createServer((request, response) => {
  captureResponse(response, `telegram-${++telegramResponseSequence}`);
  void api.handle(request, response).catch((error: unknown) => { trace('telegram-error', String(error)); response.writeHead(500).end(String(error)); });
});
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`;
}
async function until<T>(label: string, read: () => Promise<T> | T, accepts: (value: T) => boolean, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: T | undefined;
  while (Date.now() < deadline) { last = await read(); if (accepts(last)) return last; await delay(100); }
  throw new Error(`${stage}: ${label} timed out; last=${JSON.stringify(last)}`);
}
function inbound(marker: string) {
  const id = ++updateId;
  const update = { update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat, from: { id: 1357, is_bot: false, first_name: 'Proof Sender' }, text: marker } };
  save(`update-${id}.json`, update); trace('enqueue-telegram', { id, marker }); api.updates.enqueue(update); return id;
}
async function sessions() { return (await gateway.call('sessions.list', { agentId: 'qa', limit: 100 })).sessions as any[]; }
async function idle() { await until('target idle', async () => (await sessions()).find((row: any) => row.key === targetKey)?.hasActiveRun, (value) => value === false); }
async function sqliteFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) files.push(...await sqliteFiles(file)); else if (entry.name.endsWith('.sqlite')) files.push(file); }
  return files;
}
async function ingressRows(id: number) {
  const rows: any[] = [];
  for (const file of await sqliteFiles(path.join(gateway.tempRoot, 'state'))) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='channel_ingress_events'").get();
      if (table) rows.push(...db.prepare('SELECT queue_name,event_id,channel_id,account_id,status,claimed_at,completed_at,received_at,updated_at,payload_json FROM channel_ingress_events WHERE channel_id=? AND event_id=?').all('telegram', String(id).padStart(16, '0')).map((row: any) => ({ database: file, ...row })));
    } finally { db.close(); }
  }
  return rows;
}
function prefixComparison(before: any, after: any) {
  const left = before.body.input ?? [], right = after.body.input ?? [];
  let commonItems = 0;
  while (commonItems < Math.min(left.length, right.length) && JSON.stringify(left[commonItems]) === JSON.stringify(right[commonItems])) commonItems++;
  return { before: before.sequence, after: after.sequence, beforeKind: before.kind, afterKind: after.kind, strictExtension: commonItems === left.length && right.length > left.length, commonItems, beforeLength: left.length, afterLength: right.length, firstDifferentBefore: left[commonItems], firstDifferentAfter: right[commonItems], instructionsEqual: JSON.stringify(before.body.instructions) === JSON.stringify(after.body.instructions), toolsEqual: JSON.stringify(before.body.tools) === JSON.stringify(after.body.tools) };
}
// Classification only: raw provider arrays/comparisons above remain untouched.
function authoredMarkerText(item: any): string | undefined {
  if (item?.role !== 'user') return undefined;
  const text = typeof item.content === 'string' ? item.content : (item.content ?? []).map((part: any) => part.text ?? '').join('\n');
  return isInternalRuntimeContextCarrierText(text) ? undefined : text;
}
function namedReplacements(before: any, after: any) {
  const authored = (input: any[]) => input.flatMap((item: any, rawIndex: number) => {
    const text = authoredMarkerText(item);
    return text === undefined ? [] : [{ item, rawIndex, text }];
  });
  const left = authored(before.body.input ?? []), right = authored(after.body.input ?? []);
  let authoredOrdinal = 0;
  while (authoredOrdinal < Math.min(left.length, right.length) && JSON.stringify(left[authoredOrdinal].item) === JSON.stringify(right[authoredOrdinal].item)) authoredOrdinal++;
  // Carrier shifts cannot count: only the FIRST changed authored USER ordinal may match.
  const prior = left[authoredOrdinal], next = right[authoredOrdinal];
  return prior?.text.includes(M.notify) && !prior.text.includes(M.queued) && next?.text.includes(M.queued)
    ? [{ authoredOrdinal, precedingAuthoredEntriesRawEqual: true, beforeRawIndex: prior.rawIndex, afterRawIndex: next.rawIndex, beforeRequest: before.sequence, afterRequest: after.sequence, beforeItem: prior.item, afterItem: next.item, beforeText: prior.text, afterText: next.text }]
    : [];
}
try {
  const apiRoot = await listen(telegram), providerRoot = await listen(provider);
  stage = 'gateway-start';
  gateway = await owner.start(telegramGatewayOptions({
    workspace: path.join(out, 'workspace'), apiRoot,
    command: { executablePath: process.execPath, argsPrefix: [path.join(repo, 'dist', 'index.js')], argsSuffix: ['--verbose'], cwd: repo, usePackagedPlugins: true },
    providerMode: 'mock-openai', providerBaseUrl: `${providerRoot}/v1`, primaryModel: 'mock-openai/qa-row2', alternateModel: 'mock-openai/qa-row2',
    telegram: telegramProofChannel(apiRoot, BOT_TOKEN, { commands: { native: false }, streaming: { mode: 'off' } }, { groupPolicy: 'open', groups: { '*': { requireMention: false } } }),
    messages: { groupChat: { visibleReplies: 'automatic' }, queue: { mode: 'followup', debounceMs: 0 } },
    mutateConfig: (cfg: any) => { cfg.logging = { level: 'debug', file: path.join(out, 'gateway.log') }; cfg.diagnostics = { ...cfg.diagnostics, enabled: true }; cfg.bindings = [{ agentId: 'qa', match: { channel: 'telegram', accountId: 'proof' } }]; cfg.tools = { ...cfg.tools, allow: ['sessions_send'], toolSearch: { enabled: false }, sessions: { ...cfg.tools?.sessions, visibility: 'all' } }; return cfg; },
  }));
  assert.notEqual(new URL(gateway.baseUrl).port, '18789');
  await until('actual getUpdates polling', () => api.updates.pendingPolls.size, (count) => count > 0);
  stage = 'seed'; inbound(M.seed);
  await until('seed delivered', () => api.calls, (calls: any[]) => calls.some((call) => call.method === 'sendMessage' && call.body.text === 'ROW2-REPLIED-SEED'));
  const routes = (await sessions()).filter((row: any) => row.lastChannel === 'telegram' && row.lastTo === `telegram:${CHAT_ID}` && row.lastAccountId === 'proof');
  assert.equal(routes.length, 1, 'need exactly one real Telegram route'); targetKey = routes[0].key; save('target.json', { targetKey }); await idle();
  stage = 'incumbent'; inbound(M.hold); await until('incumbent provider barrier', () => Boolean(held), Boolean);
  stage = 'queued-durable-intake'; const queuedId = inbound(M.queued);
  const beforeRelease = await until('durable queued Telegram row', () => ingressRows(queuedId), (rows: any[]) => rows.some((row) => row.payload_json.includes(M.queued)));
  save('queued-ingress-before-notify.json', beforeRelease);
  save('history-before-notify.json', await gateway.call('chat.history', { sessionKey: targetKey, limit: 100 }));
  trace('queued-adoption-observation', { completedBeforeNotify: beforeRelease.some((row: any) => row.completed_at !== null) });
  assert.equal(providerRequests.some((request) => request.kind === 'queued'), false, 'queued turn started while incumbent still held');
  stage = 'send-real-notify';
  const sender = await gateway.call('chat.send', { sessionKey: 'agent:qa:row2-sender', message: M.sender, deliver: false, idempotencyKey: 'row2-sender-once' }); save('sender-start.json', sender);
  await until('actual sessions_send result', () => senderReceipt, Boolean);
  assert.ok(['accepted', 'ok'].includes(senderReceipt.status), 'ordinary sessions_send was refused or did not accept target work');
  assert.ok(typeof senderReceipt.runId === 'string', 'ordinary sessions_send did not return a target run identity');
  save('queued-ingress-after-notify.json', await ingressRows(queuedId));
  stage = 'release-and-drain'; releaseHold();
  await until('queued Telegram provider request', () => providerRequests.some((request) => request.kind === 'queued'), Boolean);
  await until('queued Telegram reply delivered', () => api.calls, (calls: any[]) => calls.some((call) => call.method === 'sendMessage' && call.body.text === 'ROW2-REPLIED-QUEUED'));
  await idle();
  const sendWait = await gateway.call('agent.wait', { runId: senderReceipt.runId, timeoutMs: 60_000 }, { timeoutMs: 65_000 });
  save('target-intersession-wait.json', sendWait);
  assert.equal(sendWait.status, 'ok', 'accepted inter-session work did not settle successfully');
  await idle();
  const queuedFinal = await ingressRows(queuedId); save('queued-ingress-final.json', queuedFinal);
  assert.ok(queuedFinal.length > 0 && queuedFinal.every((row: any) => row.completed_at !== null), 'queued input did not complete durable adoption');
  stage = 'ordinary-append-control'; inbound(M.control);
  await until('control reply delivered', () => api.calls, (calls: any[]) => calls.some((call) => call.method === 'sendMessage' && call.body.text === 'ROW2-REPLIED-CONTROL'));
  await idle();
  const target = providerRequests.filter((request) => ['seed', 'incumbent', 'queued', 'notify', 'control'].includes(request.kind));
  const comparisons = target.slice(1).map((after, index) => prefixComparison(target[index], after));
  save('prefix-comparisons.json', comparisons);
  const notify = target.find((request) => request.kind === 'notify'), queued = target.find((request) => request.kind === 'queued');
  const namedOrder = Boolean(notify && queued && notify.sequence < queued.sequence);
  const namedPrefix = namedOrder ? prefixComparison(notify, queued) : undefined;
  const inputOnce = target.filter((request) => ['queued', 'control'].includes(request.kind)).map((request) => ({ sequence: request.sequence, authoredQueuedItems: (request.body.input ?? []).filter((item: any) => item.role === 'user' && JSON.stringify(item.content).includes(M.queued)).length }));
  assert.ok(inputOnce.every((row) => row.authoredQueuedItems === 1), 'queued Telegram text missing/duplicated in later provider input');
  const failures = comparisons.filter((comparison) => !comparison.strictExtension);
  assert.equal(providerErrors.length, 0, 'provider fixture errors (including 500/retry) invalidate the product observation');
  const replacements = namedOrder ? namedReplacements(notify, queued) : [];
  save('named-authored-item-replacements.json', replacements);
  const namedDefect = namedOrder && replacements.length > 0;
  const outcome = !namedOrder ? 'named_schedule_not_reproduced' : namedDefect ? 'named_authored_notify_replaced_by_telegram' : failures.length ? 'unclassified_prefix_observation' : 'named_schedule_prefix_preserved';
  verdict = { outcome, reason: !notify ? 'ordinary sessions_send produced no standalone notify provider request; inspect actual targetDisposition (it may have steered the incumbent)' : !namedOrder ? 'queued Telegram provider turn preceded notify; raw carrier differences do not establish the named schedule' : namedDefect ? 'the first changed authored USER ordinal replaced notify with queued Telegram, with all earlier authored items raw-object equal' : failures.length ? 'raw prefix mismatch without the named authored-item replacement; provider runtime-carrier projection may differ intentionally' : undefined, targetOrder: target.map(({ sequence, kind }) => ({ sequence, kind })), senderReceipt, explicitModeNotifyNote: 'not used; the explicit notify mode only queues a passive event on this pin', namedPrefix, namedDefect, replacements, allHistoryPrefixesAppendOnly: failures.length === 0, prefixFailureCount: failures.length, inputOnce, providerErrors, rawRequestsPreserved: true, scope: 'one held-incumbent schedule; no forced priority, helper persistence, transcript writes, or real external services' };
  // mock-openai/qa-row2 may project historical runtime carriers intentionally.
  // Only the exact authored user-item replacement is row2 RED; raw input never changes.
  process.exitCode = !namedOrder ? 0 : namedDefect ? 1 : failures.length ? 3 : 0;
} catch (error: unknown) {
  verdict = { outcome: 'setup_error', stage, error: String(error), stack: error instanceof Error ? error.stack : undefined, providerErrors };
  process.exitCode = 2;
} finally {
  const cleanupErrors: string[] = [];
  try { releaseHold(); } catch (error) { cleanupErrors.push(`release provider: ${String(error)}`); }
  try { if (gateway) writeEvidence('gateway-captured.log', gateway.logs()); } catch (error) { artifactErrors.push(`gateway logs: ${String(error)}`); }
  save('telegram-api-calls.json', api.calls);
  // Artifact work cannot skip the process owner or either HTTP listener owner.
  const stop = await owner.stop({ keepTemp: true }).catch((error: unknown) => ({ process: 'unconfirmed', errors: [String(error)] }));
  if (stop.process === 'unconfirmed' || stop.errors.length) cleanupErrors.push(`gateway: ${JSON.stringify(stop)}`);
  let retainedFiles = 0;
  if (gateway && stop.process === 'confirmed-stopped' && stop.errors.length === 0) {
    // Copy only synthetic state data AFTER process settlement, inside the uploaded evidence.
    // No dependency, build, cache, symlink target, or duplicate archive is copied.
    const retain = (source: string, relative = '') => {
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        const child = path.join(source, entry.name), target = path.join(out, 'retained-state', relative, entry.name);
        if (entry.isDirectory() && !['node_modules', 'dist', 'cache', '.cache'].includes(entry.name)) retain(child, path.join(relative, entry.name));
        else if (entry.isFile() && /(?:\.sqlite(?:-wal|-shm)?|\.json)$/.test(entry.name)) {
          mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(child, target); retainedFiles++;
        }
      }
    };
    artifact('retained-state', () => retain(path.join(gateway.tempRoot, 'state')));
    artifact('retained-state/synthetic-config.json', () => { mkdirSync(path.join(out, 'retained-state'), { recursive: true }); copyFileSync(gateway.configPath, path.join(out, 'retained-state', 'synthetic-config.json')); });
  }
  const stoppedHttp = await Promise.allSettled([telegram, provider].map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }));
  for (const [index, result] of stoppedHttp.entries()) if (result.status === 'rejected') cleanupErrors.push(`http-${index}: ${String(result.reason)}`);
  save('cleanup.json', { ...stop, cleanupErrors, tempRoot: gateway?.tempRoot, retainedFiles, retainedStateInsideEvidence: retainedFiles > 0 });
  if (providerErrors.length || artifactErrors.length || cleanupErrors.length) {
    verdict = { outcome: 'setup_error', stage: 'fixture-or-evidence-or-cleanup', providerErrors, artifactErrors, cleanupErrors, observationOnly: verdict };
    process.exitCode = 2;
  }
  save('verdict.json', verdict);
  // A verdict-write failure can itself occur after the previous artifact check.
  if (artifactErrors.length && verdict.outcome !== 'setup_error') { verdict = { outcome: 'setup_error', stage: 'verdict-artifact', artifactErrors, observationOnly: verdict }; process.exitCode = 2; save('verdict.json', verdict); }
  console.log(JSON.stringify(verdict));
}

}
await main().catch((error: unknown) => {
  const failedOut = path.resolve(process.env.ROW2_EVIDENCE ?? 'row2-runtime-evidence');
  mkdirSync(failedOut, { recursive: true });
  writeFileSync(path.join(failedOut, 'verdict.json'), JSON.stringify({ outcome: 'setup_error', stage: 'prelaunch-import-or-pin', error: String(error), stack: error instanceof Error ? error.stack : undefined }, null, 2) + '\n');
  console.error(String(error)); process.exitCode = 2;
});
