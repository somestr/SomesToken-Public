import { spawn } from 'node:child_process';
import { request } from 'node:http';
import path from 'node:path';
import { Duplex, Transform } from 'node:stream';

import { CODEX_HOOK_EVENTS } from '../package-check.mjs';
import { packageArtifactName } from '../plugin-manifest.mjs';

const PLUGIN_NAME = 'somestoken';
const MARKETPLACE_NAME = 'somestoken-local';
const PLUGIN_ID = PLUGIN_NAME + '@' + MARKETPLACE_NAME;
const EVENTS = CODEX_HOOK_EVENTS.map(event => event[0].toLowerCase() + event.slice(1));
const TRUST_STATUSES = new Set(['trusted', 'managed', 'untrusted', 'modified']);
const MAX_OUTPUT_BYTES = 256 * 1024;
const TIMEOUT_MS = 3_000;
const CLOSE_GRACE_MS = 100;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function countHooks(result, cwd, sourcePath) {
  if (!Array.isArray(result.data) || result.data.length !== 1) return null;
  const [entry] = result.data;
  if (entry?.cwd !== cwd || !Array.isArray(entry.errors) || entry.errors.length !== 0
      || !Array.isArray(entry.warnings) || entry.warnings.length !== 0 || !Array.isArray(entry.hooks)) return null;

  const remainingEvents = new Set(EVENTS);
  const seenKeys = new Set();
  let trusted = 0;
  let disabled = 0;
  for (const hook of entry.hooks) {
    if (!isObject(hook)) return null;
    if (hook.pluginId !== PLUGIN_ID) continue;
    if (hook.source !== 'plugin' || hook.sourcePath !== sourcePath
        || !remainingEvents.delete(hook.eventName) || typeof hook.key !== 'string' || !hook.key.trim()
        || seenKeys.has(hook.key) || typeof hook.enabled !== 'boolean' || !TRUST_STATUSES.has(hook.trustStatus)) return null;
    seenKeys.add(hook.key);
    if (hook.trustStatus === 'trusted' || hook.trustStatus === 'managed') trusted += 1;
    if (!hook.enabled) disabled += 1;
  }
  return remainingEvents.size === 0 ? { total: EVENTS.length, trusted, disabled } : null;
}

function proxyWebSocket(transport) {
  // The proxy relays HTTP and WebSocket bytes over stdio to the existing daemon.
  return new WebSocket('ws://localhost/', {
    dispatcher: {
      dispatch(options, handler) {
        const headers = { ...options.headers };
        delete headers['sec-websocket-extensions'];
        const upgrade = request({
          hostname: 'localhost', path: options.path, maxHeaderSize: 8 * 1024,
          headers: { ...headers, host: 'localhost', connection: 'Upgrade', upgrade: 'websocket' },
          createConnection: () => transport,
        });
        const controller = { abort: error => upgrade.destroy(error) };
        // Transitional Undici 7 exposes both upgrade callbacks but starts with onConnect.
        const modern = typeof handler.onRequestStart === 'function';
        let handled = false;

        const fail = error => {
          if (handled) return;
          handled = true;
          if (modern) handler.onResponseError(controller, error);
          else handler.onError(error);
        };
        upgrade.on('error', fail);
        upgrade.once('response', response => {
          response.destroy();
          fail(new Error('Codex proxy did not upgrade'));
        });
        upgrade.once('upgrade', (response, socket, head) => {
          if (response.statusCode !== 101 || Object.hasOwn(response.headers, 'sec-websocket-extensions')) {
            fail(new Error('Unsupported Codex proxy upgrade'));
            return;
          }
          if (handled) return;
          handled = true;
          socket.pause();
          if (head.length) socket.unshift(head);
          controller.rawHeaders = response.rawHeaders.map(value => Buffer.from(value, 'latin1'));
          if (modern) handler.onRequestUpgrade(controller, response.statusCode, response.headers, socket);
          else handler.onUpgrade(response.statusCode, controller.rawHeaders, socket);
        });
        if (modern) handler.onRequestStart(controller);
        else handler.onConnect(controller.abort);
        upgrade.end();
        return true;
      },
    },
  });
}

function observeHooks(command, version, cwd) {
  return new Promise(resolve => {
    const child = spawn(command, ['--no-daemon', 'app-server', 'proxy'], {
      cwd, shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    // Bound all proxy stdout before the HTTP and WebSocket parsers see it.
    let received = 0;
    const output = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_OUTPUT_BYTES) callback(new Error('Codex proxy response exceeds byte limit'));
        else callback(null, chunk);
      },
    });
    const transport = Duplex.from({ readable: output, writable: child.stdin });
    // WebSocket diagnostics use the socket-shaped API even for a pipe.
    transport.address = () => ({});
    let socket;
    let expectedId = 1;
    let sourcePath;
    let status = null;
    let closing = false;
    let killed = false;
    let closeTimer;
    const deadline = setTimeout(finish, TIMEOUT_MS);

    function dispose() {
      transport.destroy();
      output.destroy();
      child.stdin.destroy();
      child.stdout.destroy();
      if (child.exitCode === null && child.signalCode === null) killed = child.kill('SIGKILL');
    }

    function finish(result = null) {
      if (closing) return;
      closing = true;
      status = result;
      clearTimeout(deadline);
      if (status === null) {
        dispose();
      } else {
        socket.close();
        closeTimer = setTimeout(dispose, CLOSE_GRACE_MS);
      }
    }

    function send(message) {
      socket.send(JSON.stringify({ jsonrpc: '2.0', ...message }));
    }

    child.on('error', () => finish());
    child.stdin.on('error', () => finish());
    child.stdout.on('error', () => finish());
    output.on('error', () => finish());
    transport.on('error', () => finish());
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      clearTimeout(closeTimer);
      transport.destroy();
      output.destroy();
      resolve(code === 0 || (killed && signal === 'SIGKILL') ? status : null);
    });
    child.stdout.pipe(output);

    try {
      socket = proxyWebSocket(transport);
      socket.addEventListener('error', () => finish());
      socket.addEventListener('close', () => finish());
      socket.addEventListener('open', () => {
        if (closing) return;
        transport.resume();
        send({
          id: 1, method: 'initialize',
          params: { clientInfo: { name: 'somestoken_setup', version: '1' }, capabilities: { experimentalApi: true } },
        });
      });
      socket.addEventListener('message', event => {
        if (closing) return;
        try {
          if (typeof event.data !== 'string') return finish();
          const message = JSON.parse(event.data);
          if (!isObject(message) || (Object.hasOwn(message, 'jsonrpc') && message.jsonrpc !== '2.0')
              || Object.hasOwn(message, 'error')) return finish();
          if (Object.hasOwn(message, 'method')) {
            if (typeof message.method !== 'string' || !message.method.trim() || Object.hasOwn(message, 'id')
                || Object.hasOwn(message, 'result') || (Object.hasOwn(message, 'params')
                  && !isObject(message.params) && !Array.isArray(message.params))) finish();
            return;
          }
          if (message.id !== expectedId || !isObject(message.result)) return finish();
          if (expectedId === 2) return finish(countHooks(message.result, cwd, sourcePath));

          const { codexHome } = message.result;
          if (typeof codexHome !== 'string' || !path.isAbsolute(codexHome) || codexHome.includes('\0')) return finish();
          sourcePath = path.join(codexHome, 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME, version, 'hooks', 'codex-hooks.json');
          expectedId = 2;
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } });
        } catch {
          finish();
        }
      });
    } catch {
      finish();
    }
  });
}

const [command, version] = process.argv.slice(2);
let result = null;
try {
  if (command && packageArtifactName({ name: PLUGIN_NAME, version })) result = await observeHooks(command, version, process.cwd());
} catch {
  // Host or working directory unavailable.
}
process.stdout.write(JSON.stringify(result) + '\n');
