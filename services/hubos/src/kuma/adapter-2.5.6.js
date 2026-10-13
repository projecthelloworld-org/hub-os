import { io } from 'socket.io-client';
import { CollectionError } from '../connector-runtime/http-client.js';

// All undocumented Socket.IO events live here and are integration-tested against 2.5.6.
export class Kuma256Session {
  constructor({ url, username, password, timeoutMs = 15000, socketFactory = io }) {
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.monitors = {};
    this.notifications = [];
    this.apiKeys = [];
    this.beats = new Map();
    this.info = {};
    this.infoReceived = false;
    this.createdAdmin = false;
    this.socket = socketFactory(url, { transports: ['websocket'], autoConnect: false, reconnection: false, timeout: timeoutMs });
    this.socket.on('info', (info) => { this.infoReceived = true; this.info = { ...this.info, ...info }; });
    this.socket.on('monitorList', (list) => { this.monitors = list; });
    this.socket.on('notificationList', (list) => { this.notifications = list; });
    this.socket.on('apiKeyList', (list) => { this.apiKeys = list; });
    this.socket.on('heartbeatList', (id, list) => {
      const latest = Array.isArray(list) ? list.at(-1) : null;
      if (latest) this.beats.set(String(id), { status: latest.status, ping: latest.ping, time: latest.time });
    });
  }

  async call(event, ...args) {
    try { return await this.socket.timeout(this.timeoutMs).emitWithAck(event, ...args); }
    catch { throw new CollectionError('KUMA_PROTOCOL_TIMEOUT'); }
  }

  async requireOk(event, ...args) {
    const reply = await this.call(event, ...args);
    if (reply?.tokenRequired) throw new CollectionError('KUMA_TWO_FACTOR_REQUIRES_OPERATOR');
    if (reply?.ok !== true) throw new CollectionError(event === 'login' ? 'KUMA_AUTHENTICATION_FAILED' : 'KUMA_PROTOCOL_ERROR');
    return reply;
  }

  async open({ allowSetup = false } = {}) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new CollectionError('KUMA_CONNECTION_TIMEOUT')), this.timeoutMs);
      this.socket.once('connect', () => { clearTimeout(timeout); resolve(); });
      this.socket.once('connect_error', () => { clearTimeout(timeout); reject(new CollectionError('KUMA_CONNECTION_FAILED')); });
      this.socket.connect();
    });
    // Kuma registers its request handlers after its initial asynchronous info send.
    if (!this.infoReceived) await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new CollectionError('KUMA_PROTOCOL_TIMEOUT')), this.timeoutMs);
      this.socket.once('info', () => { clearTimeout(timeout); resolve(); });
    });
    const needSetup = await this.call('needSetup');
    if (needSetup) {
      if (!allowSetup) throw new CollectionError('KUMA_NOT_PROVISIONED');
      await this.requireOk('setup', this.username, this.password);
      this.createdAdmin = true;
    }
    await this.requireOk('login', { username: this.username, password: this.password });
    if (this.info.version !== '2.5.6') throw new CollectionError('KUMA_UNSUPPORTED_VERSION');
    return this;
  }

  async addMonitor(definition, notificationId) {
    const reply = await this.requireOk('add', {
      type: 'http', name: definition.name, description: 'HubOS managed reachability check; not evidence of community internet availability.',
      url: definition.url, method: 'GET', parent: null, interval: definition.interval_seconds ?? 60,
      retryInterval: definition.interval_seconds ?? 60, timeout: 10, maxretries: definition.max_retries ?? 0, resendInterval: 1,
      notificationIDList: { [notificationId]: true }, accepted_statuscodes: ['200-299'], active: true,
      ignoreTls: false, upsideDown: false, maxredirects: 0,
      saveResponse: false, saveErrorResponse: false, responseMaxLength: 0,
      kafkaProducerBrokers: [], kafkaProducerSaslOptions: { mechanism: 'None' }, conditions: [], rabbitmqNodes: [],
    });
    return String(reply.monitorID);
  }

  async ensureNotification({ url, webhookKey }) {
    const name = 'HubOS incident routing';
    const matches = this.notifications.filter((item) => item.name === name);
    if (matches.length > 1) throw new CollectionError('KUMA_AMBIGUOUS_MANAGED_NOTIFICATION');
    if (matches[0]) {
      const config = typeof matches[0].config === 'string' ? JSON.parse(matches[0].config) : matches[0].config;
      let headers;
      try { headers = JSON.parse(config.webhookAdditionalHeaders); } catch { throw new CollectionError('KUMA_ROUTING_CONFIGURATION_CHANGED'); }
      if (config.webhookURL !== url || headers['x-hubos-webhook-key'] !== webhookKey) throw new CollectionError('KUMA_ROUTING_CONFIGURATION_CHANGED');
      return matches[0].id;
    }
    const reply = await this.requireOk('addNotification', {
      name, type: 'webhook', isDefault: false, active: true, applyExisting: false,
      webhookURL: url, webhookContentType: 'json', httpMethod: 'post',
      webhookAdditionalHeaders: JSON.stringify({ 'x-hubos-webhook-key': webhookKey }),
    }, null);
    return reply.id;
  }

  close() { this.socket.disconnect(); }
}

export async function withKumaSession(options, action, { allowSetup = false } = {}) {
  const session = new Kuma256Session(options);
  try { await session.open({ allowSetup }); return await action(session); }
  finally { session.close(); }
}
