// ==UserScript==
// @name         WhatsApp Web -> Commands (Flowgate/Firebase)
// @namespace    wa2cmd
// @version      7.0
// @description  Sends HOLDON/HOLDOFF commands when monitored WhatsApp contacts receive unread or open-chat messages. Robust floating UI, Flowgate Firebase transport, and legacy Firebase fallback.
// @author       voce
// @match        https://web.whatsapp.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      identitytoolkit.googleapis.com
// @connect      ptrainer-sinal-default-rtdb.firebaseio.com
// @connect      petrainer998-default-rtdb.firebaseio.com
// ==/UserScript==

(function () {
  'use strict';

  const LS_KEY = 'wa2cmd.settings.v1';
  const MAX_LOG_LINES = 200;
  const MAX_SEEN_MESSAGES = 500;

  const LEGACY_DB_URL = 'https://petrainer998-default-rtdb.firebaseio.com';
  const LEGACY_CHAT_PATH = 'livechat_v1/messages';
  const LEGACY_URL = `${LEGACY_DB_URL}/${LEGACY_CHAT_PATH}.json`;

  const FLOWGATE_DB_URL = 'https://ptrainer-sinal-default-rtdb.firebaseio.com';
  const FLOWGATE_ROOM_ROOT = 'flowgate/rooms';
  const FLOWGATE_PROTO = 'flowgate-peerjs-v1';
  const FLOWGATE_API_KEY = 'AIzaSyCwlgt8N4S6iFL_w0_-YFiB2T94vvOguOQ';
  const FLOWGATE_AUTH_KEY = 'wa2cmd.flowgateAuth.v1';

  const DEFAULT_SETTINGS = {
    mode: 'SHOCK',
    level: 30,
    channel: 1,
    durationMs: 300,
    gapMs: 200,
    pulses: 1,
    cooldownMs: 0,
    armed: false,
    panelX: null,
    panelY: null,
    monitoredContacts: [],
    openChatEnabled: false,
    vibTypingEnabled: false,
    vibTypingLevel: 10,
    transport: 'flowgate',
    flowgateRoom: 'PET998DR',
    flowgatePass: '',
    senderName: 'wpp_talk'
  };

  const MODE_LABELS = {
    SHOCK: 'SHOCK',
    VIBRATION: 'VIB',
    BEEP: 'BEEP',
    LIGHT: 'LIGHT'
  };

  let settings = loadSettings();
  let ui = {};
  let panelVisible = true;
  let initialized = false;
  let hotkeyReady = false;
  let pendingLogs = [];

  const queue = [];
  let queueBusy = false;
  let lastExecTs = 0;

  const lastUnreadMap = {};
  const lastTypingMap = {};
  let typingSidebarWasOn = false;

  let sidebarObserver = null;
  let sidebarPollTimer = null;
  let activePollTimer = null;
  let activeChatName = '';
  const seenActiveMessageIds = new Set();
  let flowgateAuthPromise = null;
  let sidebarScanBusy = false;

  const CID = getCid();

  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch (e) {
      console.error('[WA2CMD] settings read failed:', e);
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(settings));
    } catch (e) {
      console.error('[WA2CMD] settings save failed:', e);
    }
  }

  function getCid() {
    const key = 'lc_cid';
    try {
      let cid = sessionStorage.getItem(key);
      if (!cid) {
        cid = 'wa2cmd_' + Math.random().toString(36).slice(2);
        sessionStorage.setItem(key, cid);
      }
      return cid;
    } catch {
      return 'wa2cmd_' + Math.random().toString(36).slice(2);
    }
  }

  function nowStr() {
    const d = new Date();
    return [
      String(d.getHours()).padStart(2, '0'),
      String(d.getMinutes()).padStart(2, '0'),
      String(d.getSeconds()).padStart(2, '0')
    ].join(':');
  }

  function appendLog(line) {
    const msg = `[${nowStr()}] ${String(line || '').slice(0, 500)}`;
    if (!ui.log) {
      pendingLogs.push(msg);
      if (pendingLogs.length > 40) pendingLogs.shift();
      return;
    }
    const div = document.createElement('div');
    div.textContent = msg;
    ui.log.appendChild(div);
    while (ui.log.children.length > MAX_LOG_LINES) {
      ui.log.removeChild(ui.log.firstChild);
    }
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function flushPendingLogs() {
    const logs = pendingLogs;
    pendingLogs = [];
    logs.forEach((line) => {
      const div = document.createElement('div');
      div.textContent = line;
      ui.log.appendChild(div);
    });
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function clamp(n, min, max) {
    n = Number(n) || 0;
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    return n;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function arrUnique(a) {
    return Array.from(new Set(a.filter(Boolean)));
  }

  function textNorm(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();
  }

  function sanitizeId(raw) {
    return String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'room';
  }

  function hashString(input) {
    const str = String(input || '');
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash.toString(16);
  }

  function buildRoomHostId(roomId, password) {
    const base = sanitizeId(roomId);
    const passHash = password ? hashString(password) : 'nopass';
    const prefix = 'room-';
    const suffix = `-${passHash}`;
    const keep = Math.max(1, 50 - prefix.length - suffix.length);
    return `${prefix}${base.slice(0, keep)}${suffix}`;
  }

  function createUI() {
    if (ui.host && document.documentElement.contains(ui.host)) return true;
    const mount = document.body;
    if (!mount) return false;

    const host = document.createElement('div');
    host.id = 'wa2cmd-host';
    Object.assign(host.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      pointerEvents: 'none'
    });

    const shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
        .launcher {
          position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
          pointer-events: auto; border: 1px solid #53616f; border-radius: 8px;
          background: #121820; color: #f4f7fb; font-size: 12px; font-weight: 700;
          padding: 8px 10px; cursor: pointer; box-shadow: 0 8px 20px rgba(0,0,0,.35);
        }
        .panel {
          position: fixed; right: 16px; bottom: 56px; width: 360px; max-width: calc(100vw - 24px);
          max-height: min(82vh, 760px); z-index: 2147483647; pointer-events: auto;
          display: flex; flex-direction: column; background: rgba(17, 22, 29, .98);
          border: 1px solid #4b5563; border-radius: 8px; color: #e5e7eb;
          box-shadow: 0 14px 34px rgba(0,0,0,.55); overflow: hidden;
        }
        .hidden { display: none; }
        .header { display:flex; align-items:center; gap:8px; padding:8px 10px; background:#0b1117; border-bottom:1px solid #303946; cursor:move; }
        .title { font-size:13px; font-weight:700; white-space:nowrap; }
        .spacer { flex:1; }
        .body { padding:8px 10px; display:flex; flex-direction:column; gap:7px; overflow:auto; }
        .row { display:flex; gap:6px; align-items:center; }
        .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap:6px; }
        .grid4 { display:grid; grid-template-columns: repeat(4, 1fr); gap:6px; }
        label, .hint { color:#aab4c0; font-size:11px; }
        input, select, button { font-size:12px; }
        input, select {
          width:100%; border:1px solid #4b5563; border-radius:5px; background:#0b1117;
          color:#e5e7eb; padding:4px 5px; min-height:26px;
        }
        button {
          border:1px solid #4b5563; border-radius:6px; background:#1f2937; color:#e5e7eb;
          padding:5px 8px; cursor:pointer;
        }
        button.active { border-color:#93c5fd; background:#1e3a5f; }
        button.close { border:none; background:transparent; padding:2px 4px; color:#9ca3af; font-size:16px; }
        .armed { display:flex; align-items:center; gap:5px; color:#f97316; font-size:11px; font-weight:800; }
        .armed.on { color:#22c55e; }
        .warn { color:#facc15; font-size:11px; }
        .status { color:#cbd5e1; font-size:11px; }
        .log { height:150px; overflow:auto; border:1px solid #303946; border-radius:6px; background:#05070a; padding:5px; color:#d1d5db; font: 11px ui-monospace, Consolas, monospace; }
        .modebar { display:grid; grid-template-columns: repeat(4, 1fr); gap:5px; }
      </style>
      <button class="launcher" type="button" title="Abrir WA Commands">WA CMD</button>
      <div class="panel" role="dialog" aria-label="WA Commands">
        <div class="header">
          <div class="title">WA Commands</div>
          <label class="armed"><input id="armed" type="checkbox"> ARMADO</label>
          <div class="spacer"></div>
          <button class="close" type="button" title="Ocultar">x</button>
        </div>
        <div class="body">
          <div class="warn">Use com cautela. Comece com nivel baixo.</div>
          <div class="hint" id="contactsInfo"></div>

          <label>Transporte</label>
          <select id="transport">
            <option value="flowgate">Flowgate Firebase atual</option>
            <option value="legacy">Firebase legado livechat_v1</option>
            <option value="both">Ambos</option>
          </select>

          <div class="grid2">
            <label>Sala Flowgate<input id="room" type="text"></label>
            <label>Senha Flowgate<input id="pass" type="password"></label>
          </div>

          <label>Modo base</label>
          <div class="modebar" id="modebar"></div>

          <div class="grid2">
            <label>Nivel<input id="level" type="number" min="0" max="100"></label>
            <label>Canal<input id="channel" type="number" min="1" max="16"></label>
          </div>

          <div class="grid4">
            <label>Dur ms<input id="duration" type="number" min="0" max="600000"></label>
            <label>Gap ms<input id="gap" type="number" min="0" max="600000"></label>
            <label>Pulsos<input id="pulses" type="number" min="1" max="10"></label>
            <label>Cooldown<input id="cooldown" type="number" min="0" max="600000"></label>
          </div>

          <div class="row">
            <input id="openChatEnabled" type="checkbox" style="width:auto">
            <label for="openChatEnabled" style="flex:1">Monitorar chat aberto</label>
          </div>

          <div class="row">
            <input id="typingEnabled" type="checkbox" style="width:auto">
            <label for="typingEnabled" style="flex:1">Vibrar em digitando/escrevendo</label>
            <input id="typingLevel" type="number" min="0" max="100" style="width:70px">
          </div>

          <div class="row">
            <button id="test" type="button">Teste</button>
            <button id="rescan" type="button">Revarrer lista</button>
          </div>
          <div class="status" id="status">Inicializando...</div>
          <div class="log" id="log"></div>
        </div>
      </div>
    `;

    mount.appendChild(host);

    const $ = (sel) => shadow.querySelector(sel);
    ui = {
      host,
      shadow,
      panel: $('.panel'),
      launcher: $('.launcher'),
      log: $('#log'),
      status: $('#status'),
      infoContacts: $('#contactsInfo'),
      armedBox: $('#armed'),
      armedLabel: $('.armed'),
      transport: $('#transport'),
      room: $('#room'),
      pass: $('#pass'),
      modebar: $('#modebar'),
      level: $('#level'),
      channel: $('#channel'),
      duration: $('#duration'),
      gap: $('#gap'),
      pulses: $('#pulses'),
      cooldown: $('#cooldown'),
      openChatEnabled: $('#openChatEnabled'),
      typingEnabled: $('#typingEnabled'),
      typingLevel: $('#typingLevel')
    };

    makeModeButtons();
    bindUI($);
    syncUIFromSettings();
    makeDraggable(ui.panel, $('.header'));
    flushPendingLogs();
    appendLog('UI pronta. Botao WA CMD e atalho Ctrl+Alt+U alternam o painel.');
    return true;
  }

  function makeModeButtons() {
    ui.modebar.textContent = '';
    Object.keys(MODE_LABELS).forEach((mode) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = MODE_LABELS[mode];
      btn.dataset.mode = mode;
      btn.addEventListener('click', () => {
        settings.mode = mode;
        saveSettings();
        syncModeButtons();
      });
      ui.modebar.appendChild(btn);
    });
  }

  function bindUI($) {
    ui.launcher.addEventListener('click', () => togglePanel(true));
    $('.close').addEventListener('click', () => togglePanel(false));
    $('#test').addEventListener('click', enqueueTestCommand);
    $('#rescan').addEventListener('click', () => {
      clearRowEnhancements();
      scanSidebarOnce();
      appendLog('Lista revarrida.');
    });

    ui.armedBox.addEventListener('change', () => {
      const wasTyping = typingSidebarWasOn;
      settings.armed = ui.armedBox.checked;
      saveSettings();
      syncArmedUI();
      appendLog(settings.armed ? 'Sistema ARMADO.' : 'Sistema DESARMADO.');
      if (!settings.armed && wasTyping) {
        typingSidebarWasOn = false;
        sendTypingHoldOff(true);
      }
    });

    bindSettingInput(ui.transport, 'transport', (v) => v || 'flowgate');
    bindSettingInput(ui.room, 'flowgateRoom', (v) => String(v || '').trim() || 'PET998DR');
    bindSettingInput(ui.pass, 'flowgatePass', (v) => String(v || '').trim());
    bindSettingInput(ui.level, 'level', (v) => clamp(v, 0, 100));
    bindSettingInput(ui.channel, 'channel', (v) => clamp(v, 1, 16));
    bindSettingInput(ui.duration, 'durationMs', (v) => clamp(v, 0, 600000));
    bindSettingInput(ui.gap, 'gapMs', (v) => clamp(v, 0, 600000));
    bindSettingInput(ui.pulses, 'pulses', (v) => clamp(v, 1, 10));
    bindSettingInput(ui.cooldown, 'cooldownMs', (v) => clamp(v, 0, 600000));
    bindSettingInput(ui.typingLevel, 'vibTypingLevel', (v) => clamp(v, 0, 100));

    ui.openChatEnabled.addEventListener('change', () => {
      settings.openChatEnabled = ui.openChatEnabled.checked;
      saveSettings();
      if (settings.openChatEnabled) {
        startActiveChatPolling();
        appendLog('Monitoramento do chat aberto ativado.');
      } else {
        stopActiveChatPolling();
        appendLog('Monitoramento do chat aberto desativado.');
      }
    });

    ui.typingEnabled.addEventListener('change', () => {
      settings.vibTypingEnabled = ui.typingEnabled.checked;
      saveSettings();
      appendLog(settings.vibTypingEnabled ? 'Digitando ativado.' : 'Digitando desativado.');
      if (!settings.vibTypingEnabled && typingSidebarWasOn) {
        typingSidebarWasOn = false;
        sendTypingHoldOff(true);
      }
    });
  }

  function bindSettingInput(el, key, normalize) {
    el.addEventListener('change', () => {
      settings[key] = normalize(el.value);
      el.value = settings[key];
      saveSettings();
    });
  }

  function syncUIFromSettings() {
    ui.armedBox.checked = !!settings.armed;
    ui.transport.value = settings.transport || 'flowgate';
    ui.room.value = settings.flowgateRoom || 'PET998DR';
    ui.pass.value = settings.flowgatePass || '';
    ui.level.value = settings.level;
    ui.channel.value = settings.channel;
    ui.duration.value = settings.durationMs;
    ui.gap.value = settings.gapMs;
    ui.pulses.value = settings.pulses;
    ui.cooldown.value = settings.cooldownMs;
    ui.openChatEnabled.checked = !!settings.openChatEnabled;
    ui.typingEnabled.checked = !!settings.vibTypingEnabled;
    ui.typingLevel.value = settings.vibTypingLevel;
    syncArmedUI();
    syncModeButtons();
    updateMonitoredCountUI();
    if (settings.panelX != null && settings.panelY != null) {
      ui.panel.style.left = `${settings.panelX}px`;
      ui.panel.style.top = `${settings.panelY}px`;
      ui.panel.style.right = 'auto';
      ui.panel.style.bottom = 'auto';
    }
    ui.panel.classList.toggle('hidden', !panelVisible);
  }

  function syncArmedUI() {
    ui.armedLabel.classList.toggle('on', !!settings.armed);
  }

  function syncModeButtons() {
    ui.modebar.querySelectorAll('button[data-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === settings.mode);
    });
  }

  function togglePanel(forceVisible) {
    if (!ui.panel) return;
    panelVisible = typeof forceVisible === 'boolean' ? forceVisible : !panelVisible;
    ui.panel.classList.toggle('hidden', !panelVisible);
  }

  function updateMonitoredCountUI() {
    if (!ui.infoContacts) return;
    ui.infoContacts.textContent =
      `Marque contatos na lista lateral. Monitorando: ${settings.monitoredContacts.length || 0}`;
  }

  function makeDraggable(panel, handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origX = 0;
    let origY = 0;

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = `${origX + e.clientX - startX}px`;
      panel.style.top = `${origY + e.clientY - startY}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const rect = panel.getBoundingClientRect();
      settings.panelX = Math.max(0, Math.round(rect.left));
      settings.panelY = Math.max(0, Math.round(rect.top));
      saveSettings();
    });
  }

  function getSidebarPane() {
    return safeQuery('#pane-side') ||
      safeQuery('[data-testid="chat-list"]') ||
      safeQuery('#side');
  }

  function safeQuery(selector, root) {
    try {
      return (root || document).querySelector(selector);
    } catch {
      return null;
    }
  }

  function getCandidateRows(pane) {
    if (!pane) return [];
    const selectors = [
      'div[aria-selected]',
      '[role="listitem"]',
      '[data-testid="cell-frame-container"]'
    ];
    for (const sel of selectors) {
      try {
        const rows = Array.from(pane.querySelectorAll(sel));
        if (rows.length) return rows.slice(0, 60);
      } catch {}
    }
    return [];
  }

  function getNameElement(row) {
    if (!row) return null;
    const candidates = Array.from(row.querySelectorAll('span[title], div[title]'));
    return candidates.find((el) => {
      const title = (el.getAttribute('title') || '').trim();
      if (!title) return false;
      const n = textNorm(title);
      return !/^\d{1,2}:\d{2}/.test(n) && !n.includes('mensagem') && !n.includes('message');
    }) || null;
  }

  function getContactNameFromRow(row) {
    const el = getNameElement(row);
    if (el) return (el.getAttribute('title') || el.textContent || '').trim();
    const label = (row.getAttribute('aria-label') || '').trim();
    if (label) return label.split(',')[0].trim();
    return '';
  }

  function getUnreadCountFromRow(row) {
    if (!row) return 0;
    const nodes = Array.from(row.querySelectorAll('[aria-label]')).slice(0, 20);
    for (const node of nodes) {
      const raw = `${node.getAttribute('aria-label') || ''} ${node.textContent || ''}`.trim();
      if (!raw) continue;
      const norm = textNorm(raw);
      const looksUnread = norm.includes('nao lida') ||
        norm.includes('nao lidas') ||
        norm.includes('unread') ||
        norm.includes('mensagem nao') ||
        norm.includes('messages unread');
      if (!looksUnread) continue;
      const m = raw.match(/\d+/);
      if (m) return clamp(parseInt(m[0], 10), 0, 999);
      const textOnly = String(node.textContent || '').trim();
      if (/^\d+$/.test(textOnly)) return clamp(parseInt(textOnly, 10), 0, 999);
    }
    return 0;
  }

  function rowHasTyping(row) {
    const text = textNorm(row ? row.textContent : '');
    return text.includes('digitando') || text.includes('escrevendo') || text.includes('typing');
  }

  function clearRowEnhancements() {
    document.querySelectorAll('[data-wa2cmd-enhanced]').forEach((row) => {
      row.removeAttribute('data-wa2cmd-enhanced');
    });
    document.querySelectorAll('.wa2cmd-row-check, [data-wa2cmd-row-check]').forEach((el) => el.remove());
  }

  function enhanceChatRow(row) {
    if (!row) return;
    const contactName = getContactNameFromRow(row);
    const nameEl = getNameElement(row);
    if (!contactName || !nameEl || contactName === 'WA CMD') return;

    const existingChecks = Array.from(row.querySelectorAll('.wa2cmd-row-check, [data-wa2cmd-row-check]'));
    const matching = existingChecks.find((el) => el.dataset.wa2cmdContact === contactName);
    existingChecks.forEach((el) => {
      if (el !== matching) el.remove();
    });
    if (matching) {
      const input = matching.querySelector('input[type="checkbox"]');
      if (input) input.checked = settings.monitoredContacts.includes(contactName);
      row.dataset.wa2cmdEnhanced = '1';
      return;
    }

    row.dataset.wa2cmdEnhanced = '1';

    const wrapper = document.createElement('label');
    wrapper.className = 'wa2cmd-row-check';
    wrapper.dataset.wa2cmdRowCheck = '1';
    wrapper.dataset.wa2cmdContact = contactName;
    Object.assign(wrapper.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '3px',
      marginRight: '4px',
      fontSize: '11px',
      color: '#00a884',
      verticalAlign: 'middle'
    });

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = settings.monitoredContacts.includes(contactName);
    cb.title = 'Monitorar no WA Commands';
    Object.assign(cb.style, { margin: '0', cursor: 'pointer' });

    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      if (cb.checked) {
        settings.monitoredContacts = arrUnique([...settings.monitoredContacts, contactName]);
        appendLog(`Contato monitorado: ${contactName}`);
      } else {
        settings.monitoredContacts = settings.monitoredContacts.filter((n) => n !== contactName);
        appendLog(`Contato removido: ${contactName}`);
      }
      saveSettings();
      updateMonitoredCountUI();
    });

    wrapper.appendChild(cb);
    const container = nameEl.parentElement || nameEl;
    container.insertBefore(wrapper, container.firstChild);
  }

  function handleMessageEvent(contactName, count, source) {
    const pulses = clamp(count || 1, 1, 10);
    appendLog(`${source}: ${contactName} +${pulses}`);
    enqueueCommand({
      mode: settings.mode,
      level: settings.level,
      channel: settings.channel,
      durationMs: settings.durationMs,
      pulses,
      gapMs: settings.gapMs
    }, `[${source}] ${contactName}`);
  }

  function processRow(row) {
    if (!row) return;
    enhanceChatRow(row);

    const contactName = getContactNameFromRow(row);
    if (!contactName) return;

    const monitored = settings.monitoredContacts.includes(contactName);
    const unread = getUnreadCountFromRow(row);
    const prevUnread = lastUnreadMap[contactName];

    if (prevUnread === undefined) {
      lastUnreadMap[contactName] = unread;
    } else {
      if (settings.armed && monitored && unread > prevUnread) {
        handleMessageEvent(contactName, unread - prevUnread, 'UNREAD');
      }
      lastUnreadMap[contactName] = unread;
    }

    lastTypingMap[contactName] = rowHasTyping(row);
    recomputeTypingGlobal();
  }

  function scanSidebarOnce() {
    if (sidebarScanBusy) return;
    const pane = getSidebarPane();
    if (!pane) {
      setStatus('Aguardando lista do WhatsApp...');
      return;
    }
    sidebarScanBusy = true;
    const rows = getCandidateRows(pane);
    try {
      rows.forEach(processRow);
      setStatus(`Lista OK: ${rows.length} linhas vistas. Chat ativo: ${activeChatName || '-'}`);
    } finally {
      sidebarScanBusy = false;
    }
  }

  function attachSidebarWatcher() {
    const target = getSidebarPane();
    if (!target) {
      setStatus('Aguardando lista do WhatsApp...');
      if (!sidebarPollTimer) {
        sidebarPollTimer = setInterval(() => {
          const pane = getSidebarPane();
          if (!pane) return;
          attachSidebarWatcher();
        }, 1500);
      }
      return;
    }

    scanSidebarOnce();
    if (sidebarObserver) {
      sidebarObserver.disconnect();
      sidebarObserver = null;
    }

    if (sidebarPollTimer) clearInterval(sidebarPollTimer);
    sidebarPollTimer = setInterval(scanSidebarOnce, 3500);
    appendLog('Polling da lista ativado.');
  }

  function getActiveChatName() {
    const main = document.querySelector('#main');
    if (!main) return '';
    const header = main.querySelector('header');
    if (!header) return '';
    const titled = Array.from(header.querySelectorAll('span[title], div[title]'))
      .map((el) => (el.getAttribute('title') || '').trim())
      .find(Boolean);
    if (titled) return titled;
    const span = header.querySelector('span[dir="auto"]');
    return span ? (span.textContent || '').trim() : '';
  }

  function isIncomingMessageElement(el) {
    if (!(el instanceof HTMLElement)) return false;
    const id = el.getAttribute('data-id') || '';
    return /\bfalse_/.test(id) || id.startsWith('false_');
  }

  function collectIncomingMessageIds(root) {
    if (!root) return [];
    const out = [];
    const all = root.matches && root.matches('[data-id]') ? [root] : [];
    root.querySelectorAll?.('[data-id]')?.forEach((el) => all.push(el));
    all.forEach((el) => {
      if (!isIncomingMessageElement(el)) return;
      const id = el.getAttribute('data-id');
      if (id) out.push(id);
    });
    return out;
  }

  function rememberSeenMessage(id) {
    seenActiveMessageIds.add(id);
    if (seenActiveMessageIds.size <= MAX_SEEN_MESSAGES) return;
    const first = seenActiveMessageIds.values().next().value;
    seenActiveMessageIds.delete(first);
  }

  function baselineActiveChat(main, name) {
    activeChatName = name;
    seenActiveMessageIds.clear();
    collectIncomingMessageIds(main).forEach(rememberSeenMessage);
    appendLog(`Chat ativo: ${activeChatName || '-'}. Baseline aplicado.`);
  }

  function scanActiveChatOnce() {
    const main = document.querySelector('#main');
    if (!main) return;
    const name = getActiveChatName();
    if (name !== activeChatName) {
      baselineActiveChat(main, name);
      return;
    }
    if (!settings.armed || !activeChatName || !settings.monitoredContacts.includes(activeChatName)) return;
    const fresh = [];
    collectIncomingMessageIds(main).forEach((id) => {
      if (seenActiveMessageIds.has(id)) return;
      rememberSeenMessage(id);
      fresh.push(id);
    });
    if (fresh.length) handleMessageEvent(activeChatName, fresh.length, 'OPEN_CHAT');
  }

  function startActiveChatPolling() {
    if (!settings.openChatEnabled) return;
    if (activePollTimer) clearInterval(activePollTimer);
    activePollTimer = setInterval(scanActiveChatOnce, 2500);
    appendLog('Polling leve do chat aberto ativado.');
  }

  function stopActiveChatPolling() {
    if (activePollTimer) clearInterval(activePollTimer);
    activePollTimer = null;
    activeChatName = '';
    seenActiveMessageIds.clear();
  }

  function recomputeTypingGlobal() {
    const anyTyping = Object.entries(lastTypingMap).some(([contact, val]) => {
      return !!val && settings.monitoredContacts.includes(contact);
    });

    if (!settings.vibTypingEnabled || !settings.armed) {
      if (typingSidebarWasOn) {
        typingSidebarWasOn = false;
        sendTypingHoldOff(true);
      }
      return;
    }

    if (anyTyping && !typingSidebarWasOn) {
      typingSidebarWasOn = true;
      sendTypingHoldOn(settings.vibTypingLevel, settings.channel);
    } else if (!anyTyping && typingSidebarWasOn) {
      typingSidebarWasOn = false;
      sendTypingHoldOff(true);
    }
  }

  async function sendTypingHoldOn(level, channel) {
    if (!settings.armed) return;
    const line = `HOLDON VIBRATION,${clamp(level, 0, 100)},${clamp(channel, 1, 16)}`;
    appendLog(`TYPING ON -> ${line}`);
    await pushCommandText(line);
  }

  async function sendTypingHoldOff(force) {
    if (!force && !settings.armed) return;
    appendLog('TYPING OFF -> HOLDOFF');
    await pushCommandText('HOLDOFF', { force: true });
  }

  function enqueueCommand(cmd, originText) {
    queue.push({ ...cmd, originText: originText || '' });
    runQueue();
  }

  function enqueueTestCommand() {
    appendLog('Teste solicitado.');
    enqueueCommand({
      mode: settings.mode,
      level: settings.level,
      channel: settings.channel,
      durationMs: settings.durationMs,
      pulses: settings.pulses,
      gapMs: settings.gapMs
    }, '[TESTE]');
  }

  async function runQueue() {
    if (queueBusy) return;
    queueBusy = true;
    try {
      while (queue.length) {
        await executeCommand(queue.shift());
      }
    } finally {
      queueBusy = false;
    }
  }

  async function executeCommand(cmd) {
    const mode = String(cmd.mode || 'SHOCK').toUpperCase();
    let level = clamp(cmd.level, 0, 100);
    const channel = clamp(cmd.channel, 1, 16);
    const pulses = clamp(cmd.pulses || 1, 1, 10);
    const durationMs = Math.max(0, Number(cmd.durationMs) || 0);
    const gapMs = Math.max(0, Number(cmd.gapMs) || 0);

    if (mode === 'BEEP' || mode === 'LIGHT') level = 0;

    if (!settings.armed) {
      appendLog(`CMD ignorado (desarmado): ${mode},${level},${channel}`);
      return;
    }

    const now = Date.now();
    if (settings.cooldownMs > 0 && lastExecTs > 0) {
      const elapsed = now - lastExecTs;
      if (elapsed < settings.cooldownMs) {
        await sleep(settings.cooldownMs - elapsed);
      }
    }
    lastExecTs = Date.now();

    appendLog(`Execucao: ${mode},${level},${channel} dur=${durationMs} pulses=${pulses}`);
    for (let i = 0; i < pulses; i++) {
      await pushCommandText(`HOLDON ${mode},${level},${channel}`);
      if (durationMs > 0) await sleep(durationMs);
      await pushCommandText('HOLDOFF', { force: true });
      if (i < pulses - 1 && gapMs > 0) await sleep(gapMs);
    }
    appendLog('CMD concluido.');
  }

  function requestJson(method, url, payload) {
    const data = JSON.stringify(payload);
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method,
          url,
          headers: { 'Content-Type': 'application/json' },
          data,
          timeout: 7000,
          onload: (res) => {
            if (res.status >= 200 && res.status < 300) resolve(res);
            else reject(new Error(`HTTP ${res.status}`));
          },
          onerror: () => reject(new Error('GM_xmlhttpRequest onerror')),
          ontimeout: () => reject(new Error('GM_xmlhttpRequest timeout'))
        });
      });
    }
    return fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: data
    }).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    });
  }

  async function parseJsonResponse(res) {
    if (res && typeof res.responseText === 'string') {
      return JSON.parse(res.responseText || '{}');
    }
    if (res && typeof res.json === 'function') {
      return res.json();
    }
    return {};
  }

  async function getFlowgateAuthToken() {
    try {
      const raw = localStorage.getItem(FLOWGATE_AUTH_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached && cached.idToken && Number(cached.expiresAt || 0) > Date.now() + 60000) {
          return cached.idToken;
        }
      }
    } catch {}

    if (!flowgateAuthPromise) {
      flowgateAuthPromise = (async () => {
        const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FLOWGATE_API_KEY}`;
        const res = await requestJson('POST', url, { returnSecureToken: true });
        const data = await parseJsonResponse(res);
        if (!data || !data.idToken) throw new Error('Firebase auth sem idToken');
        const ttlMs = Math.max(1, Number(data.expiresIn || 3600) - 120) * 1000;
        const cached = {
          idToken: data.idToken,
          expiresAt: Date.now() + ttlMs
        };
        try { localStorage.setItem(FLOWGATE_AUTH_KEY, JSON.stringify(cached)); } catch {}
        return data.idToken;
      })().finally(() => {
        flowgateAuthPromise = null;
      });
    }
    return flowgateAuthPromise;
  }

  function buildCommandPayload(text) {
    const now = Date.now();
    return {
      text: String(text || '').slice(0, 400),
      name: settings.senderName || 'wpp_talk',
      timestamp: now,
      id: `cmd:${now}:${Math.random().toString(36).slice(2)}`
    };
  }

  function buildFlowgateEnvelope(text) {
    return {
      __flowgate: FLOWGATE_PROTO,
      action: 'cmd',
      payload: buildCommandPayload(text),
      target: null,
      from: CID,
      sid: CID,
      ts: Date.now()
    };
  }

  async function pushFlowgate(text) {
    const roomKey = buildRoomHostId(settings.flowgateRoom || 'PET998DR', settings.flowgatePass || '');
    const token = await getFlowgateAuthToken();
    const url = `${FLOWGATE_DB_URL}/${FLOWGATE_ROOM_ROOT}/${roomKey}/actions/cmd.json?auth=${encodeURIComponent(token)}`;
    await requestJson('POST', url, buildFlowgateEnvelope(text));
    appendLog(`TX Flowgate: ${text}`);
  }

  async function pushLegacy(text) {
    await requestJson('POST', LEGACY_URL, {
      text: String(text || '').slice(0, 400),
      ts: { '.sv': 'timestamp' },
      cid: CID
    });
    appendLog(`TX legado: ${text}`);
  }

  async function pushCommandText(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    const transport = settings.transport || 'flowgate';
    try {
      if (transport === 'legacy') {
        await pushLegacy(trimmed);
      } else if (transport === 'both') {
        await Promise.all([pushFlowgate(trimmed), pushLegacy(trimmed)]);
      } else {
        await pushFlowgate(trimmed);
      }
    } catch (e) {
      appendLog(`ERR envio ${transport}: ${e && e.message ? e.message : String(e)}`);
      throw e;
    }
  }

  function setupHotkey() {
    if (hotkeyReady) return;
    hotkeyReady = true;
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.altKey && (e.key === 'u' || e.key === 'U')) {
        e.preventDefault();
        togglePanel();
      }
    }, true);
  }

  function setStatus(text) {
    if (ui.status) ui.status.textContent = text;
  }

  function init() {
    if (initialized) return;
    if (!createUI()) {
      setTimeout(init, 300);
      return;
    }
    initialized = true;
    setupHotkey();
    attachSidebarWatcher();
    if (settings.openChatEnabled) startActiveChatPolling();
    setInterval(() => {
      if (!ui.host || !document.documentElement.contains(ui.host)) {
        ui = {};
        createUI();
      }
    }, 3000);
    appendLog('Inicializacao completa.');
  }

  function boot() {
    init();
    setTimeout(init, 500);
    setTimeout(init, 1500);
    setTimeout(init, 3500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  }
  window.addEventListener('load', boot, { once: true });
  boot();
})();
