// ==UserScript==
// @name         Flashscore -> Collar (Flowgate bridge)
// @namespace    collar3
// @version      4.1
// @description  Monitora Flashscore e envia snapshots do placar via Flowgate.
// @note         4.1 - align with current Flowgate firebase/peerjs connection patterns
// @match        https://www.flashscore.com/*
// @match        https://www.flashscore.com.br/*
// @match        https://www.flashscore.*/*
// @match        https://www.espn.com/*
// @match        https://www.espn.com.br/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function(){
  'use strict';

  /**********************
   *     CONFIG/ESTADO  *
   **********************/
  const PEERJS_SERVER_HOST = '0.peerjs.com';
  const PEERJS_SERVER_PORT = 443;
  const PEERJS_SERVER_PATH = '/';
  const PEERJS_SERVER_KEY = 'peerjs';
  const SIGNALING_DEFAULT = 'firebase'; // firebase | peerjs
  const SIGNALING_ALLOWED = new Set(['firebase', 'peerjs']);
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyCwlgt8N4S6iFL_w0_-YFiB2T94vvOguOQ",
    authDomain: "ptrainer-sinal.firebaseapp.com",
    databaseURL: "https://ptrainer-sinal-default-rtdb.firebaseio.com",
    projectId: "ptrainer-sinal",
    storageBucket: "ptrainer-sinal.firebasestorage.app",
    messagingSenderId: "701767192850",
    appId: "1:701767192850:web:02cfab83d9d419540463cb"
  };
  function resolveSignalingMode(){
    const url = new URL(window.location.href);
    const signal = (url.searchParams.get('signal') || '').trim().toLowerCase();
    if (SIGNALING_ALLOWED.has(signal)) return signal;
    if (signal) {
      console.warn(`Sinalizador ignorado: ${signal}`);
    }
    const stored = S && S.signalingMode ? String(S.signalingMode).trim().toLowerCase() : '';
    return SIGNALING_ALLOWED.has(stored) ? stored : SIGNALING_DEFAULT;
  }
  const DEFAULT_ROOM = 'PET998DR';
  const DEFAULT_PASS = 'flowgate-pass-2f1b6d0f9c21419a92f2c0d4';
  const STABLE_ID_STORAGE = 'trystero_nostr_priv_hex';
  const FLOWGATE_ID_FALLBACK = 'flowgate_nostr_priv_hex';
  const TRYSTERO_ID_FALLBACK = 'trystero_nostr_priv_hex';
  const TURN_STORE_KEY = 'flowgate_turn_servers';
  const PRESENCE_INTERVAL_MS = 5000;
  const SCORE_HEARTBEAT_MS = 15000;
  const FIREBASE_ROOM_ROOT = 'flowgate/rooms';
  const FIREBASE_SESSION_GRACE_MS = 2000;
  const FIREBASE_MESSAGE_TTL_MS = 45000;
  const FIREBASE_PRESENCE_TTL_MS = 45000;
  const FIREBASE_SEEN_MAX = 1200;
  const HOST_ID_SUFFIXES = ['', 'h2', 'h3'];
  const TURN_DEFAULTS = [
    {
      username: 'esp1n',
      credential: '159753456852',
      urls: [
        'turn:34.95.255.8:3478',
        'turn:34.95.255.8:3478?transport=tcp',
        'turns:34.95.255.8:3478?transport=tcp',
        'turn:34.95.255.8:443?transport=tcp',
        'turns:34.95.255.8:443?transport=tcp',
        'turn:34.95.255.8:5349?transport=tcp',
        'turns:34.95.255.8:5349?transport=tcp'
      ]
    },
    {
      username: 'c30cf48123b0ca5f06ed610c',
      credential: 's9mJQSaRMVSTa9zy',
      urls: [
        'stun:stun.relay.metered.ca:80',
        'turn:global.relay.metered.ca:80',
        'turn:global.relay.metered.ca:80?transport=tcp',
        'turn:global.relay.metered.ca:443',
        'turns:global.relay.metered.ca:443?transport=tcp'
      ]
    }
  ];

  function loadTurnServers(){
    const TRYSTERO_TURN_FALLBACK = 'trystero_turn_servers';
    try {
      const raw = localStorage.getItem(TURN_STORE_KEY) || localStorage.getItem(TRYSTERO_TURN_FALLBACK);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch(_) { return []; }
  }

  const TURN_SERVERS = loadTurnServers();
  const TURN_CONFIG = TURN_SERVERS.length ? TURN_SERVERS : TURN_DEFAULTS;
  const ICE_CONFIGS = (() => {
    const toArray = (val) => Array.isArray(val) ? val : [];
    const stripTurn = (cfg) => ({
      ...cfg,
      urls: toArray(cfg.urls).filter((url) => /^stuns?:/i.test(String(url || '').trim()))
    });
    const stunCfg = TURN_CONFIG.map(stripTurn).filter((cfg) => (cfg.urls || []).length);
    return { stun: stunCfg.length ? stunCfg : TURN_CONFIG, turn: TURN_CONFIG };
  })();

  const SEL = {
    homeName: '.duelParticipant__home .participant__participantName a, .duelParticipant__home img.participant__image[alt]',
    awayName: '.duelParticipant__away .participant__participantName a, .duelParticipant__away img.participant__image[alt]',
    liveWrapper: '.duelParticipant__score .detailScore__wrapper.detailScore__live',
    scoreWrapper: '.duelParticipant__score .detailScore__wrapper',
    fixedWrapper: '.fixedHeaderDuel__score .fixedScore.fixedScore--live',
    fixedScoreWrapper: '.fixedHeaderDuel__score .fixedScore',
    statusText: '.duelParticipant__score .detailScore__status .fixedHeaderDuel__detailStatus, .fixedHeaderDuel__score .fixedScore__status .fixedHeaderDuel__detailStatus'
  };

  const SEL_ESPN = {
    homeName: '.Gamestrip__Team--home .ScoreCell__TeamName',
    awayName: '.Gamestrip__Team--away .ScoreCell__TeamName',
    homeScore: '.Gamestrip__Team--home .ScoreCell__Score',
    awayScore: '.Gamestrip__Team--away .ScoreCell__Score',
    liveWrapper: '.Gamestrip__SContainer'
  };

  const SEL_LIST = {
    row: '.event__match[data-event-row="true"]',
    homeName: '.event__participant--home',
    awayName: '.event__participant--away',
    homeScore: '.event__score--home',
    awayScore: '.event__score--away',
    stage: '.event__stage--block',
    link: 'a.eventRowLink'
  };

  const SEL_EVENTS = {
    row: '.smv__verticalSections .smv__participantRow',
    redIcon: '[data-testid*="red-card"], [class*="red-card"], [class*="redCard"], .redCard-ico',
    yellowIcon: '[data-testid*="yellow-card"], [class*="yellow-card"], [class*="yellowCard"], .yellowCard-ico',
    substitutionIcon: '[data-testid*="substitution"], .smv__incidentIconSub',
    minute: '.smv__timeBox',
    player: '.smv__playerName',
    subOut: '.smv__incidentSubOut .smv__playerName, .smv__subDown'
  };

  const getSite = () => {
    return window.location.hostname.includes('espn.com') ? 'espn' : 'flashscore';
  };

  const LSKEY = 'fs2arduino.settings.v13';
  const LIST_TARGET_KEY = 'fs2arduino.list-target.v1';
  const DEFAULTS = {
    trRoom: DEFAULT_ROOM,
    trPass: DEFAULT_PASS,
    username: 'bot-flashscore',
    autoConnect: true,
    noSleep: true,
    signalingMode: SIGNALING_DEFAULT
  };

  // ---------- Consentimento em iframe (evita banner recorrente) ----------
  const CONSENT = {
    key: 'flashscore-embed-consent-v1',
    requestType: 'flashscore-consent',
    ackType: 'flashscore-consent-ack',
    targetOrigins: [
      'https://www.flashscore.com.br',
      'https://www.flashscore.com',
      'https://m.flashscore.com.br',
      'https://www.flashscore.mobi'
    ]
  };
  let consentApplied = false;

  function consentBaseDomain(){
    const m = location.hostname.match(/(?:^|\.)flashscore\.[^.]+(?:\.[^.]+)?$/i);
    const base = m ? m[0].replace(/^\./,'') : location.hostname.replace(/^www\./,'');
    return base ? `.${base}` : '';
  }

  function setConsentCookies(){
    const maxAge = 60 * 60 * 24 * 365; // 1 ano
    const domain = consentBaseDomain();
    const cookieTail = `${domain ? `; domain=${domain}` : ''}; path=/; max-age=${maxAge}; SameSite=None; Secure`;
    try { document.cookie = `fs_embed_consent=granted${cookieTail}`; } catch(_){}
    try { document.cookie = `OptanonAlertBoxClosed=${Date.now()}${cookieTail}`; } catch(_){}
    try {
      const cid = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
      const stamp = encodeURIComponent(new Date().toISOString());
      const consentVal = `isIABGlobal=false&datestamp=${stamp}&version=6.33.0&hosts=&consentId=${cid}&interactionCount=1&landingPath=NotLandingPage&groups=1:1,2:1,3:1,4:1,5:1,6:1,7:1,8:1,9:1,10:1`;
      document.cookie = `OptanonConsent=${consentVal}${cookieTail}`;
    } catch(_){}
  }

  function hideConsentUi(){
    try {
      const acceptBtn = document.querySelector('#onetrust-accept-btn-handler, button[data-ot-accept-all], button[aria-label="Allow all"]');
      if (acceptBtn) acceptBtn.click();
      ['#onetrust-banner-sdk','.onetrust-pc-dark-filter','.ot-floating-button','.ot-sdk-row','.ot-sdk-container'].forEach(sel=>{
        document.querySelectorAll(sel).forEach(el=>{
          el.style.setProperty('display','none','important');
          el.style.setProperty('visibility','hidden','important');
        });
      });
    } catch(_){}
  }

  function applyConsent(reason){
    if (consentApplied) return;
    consentApplied = true;
    setConsentCookies();
    hideConsentUi();
    try { localStorage.setItem(CONSENT.key, 'granted'); } catch(_){}
    try { window.parent?.postMessage({ type: CONSENT.ackType, consent: true, granted: true }, '*'); } catch(_){}
    uiApi?.log?.(`Consentimento aplicado (${reason || 'auto'})`);
  }

  function initConsentBridge(){
    if (getSite() !== 'flashscore') return;
    try {
      if (localStorage.getItem(CONSENT.key) === 'granted') {
        applyConsent('persistido');
      }
    } catch(_){}

    window.addEventListener('message', (ev)=>{
      const data = ev?.data;
      if (!data) return;
      const isConsentMsg = data.type === CONSENT.requestType || data.consent === true;
      if (!isConsentMsg) return;
      if (data.granted === true || data.consent === true) applyConsent('pai');
    });

    const tryAuto = ()=>{
      if (consentApplied) return;
      hideConsentUi();
      const acceptBtn = document.querySelector('#onetrust-accept-btn-handler, button[data-ot-accept-all], button[aria-label="Allow all"]');
      if (acceptBtn) {
        acceptBtn.click();
        applyConsent('autoclick');
      }
    };

    const ob = new MutationObserver(()=> tryAuto());
    ob.observe(document.documentElement || document.body, { childList:true, subtree:true });
    setTimeout(tryAuto, 400);
    setTimeout(tryAuto, 1200);
  }

  function initSearchBridge(){
    window.addEventListener('message', (ev)=>{
      const data = ev?.data;
      if (!data || typeof data !== 'object') return;
      if (data.__fs_score_msg) return;
      const type = String(data.type || data.action || '').toLowerCase();
      if (!type) return;
      if (['fs-search-team','fs-select-match','fs-list-target'].includes(type)) {
        const term = String(data.term || data.team || data.query || '').trim();
        setListTargetTerm(term, 'postMessage');
      }
    });
  }

  let S = loadSettings();
  let peerModule = null;
  let PeerCtor = null;
  let peer = null;
  let hostConn = null;
  let roomHostId = '';
  let activeHostId = '';
  let hostIdIndex = 0;
  let roomSignalKey = '';
  let signalingMode = resolveSignalingMode();
  let firebaseApi = null;
  let firebaseDb = null;
  let firebaseInitPromise = null;
  let firebaseRoomKey = '';
  let firebaseSessionStart = 0;
  let firebaseConnected = false;
  let firebaseActionUnsubs = new Map();
  let firebasePresenceUnsubs = [];
  let firebasePresenceSelfRef = null;
  let firebasePresenceOnDisconnect = null;
  let firebaseCleanupTimers = new Set();
  let firebaseSeenMessages = new Set();
  let firebaseSeenQueue = [];
  let activeTransport = '';
  let trRoom = null;
  let trScoreSend = null;
  let trPresenceSend = null;
  let trConnected = false;
  let trConnecting = false;
  let trSelfId = '';
  let trPresenceTimer = null;
  let trScoreHeartbeat = null;
  let lastScoreHash = '';
  let lastEndedScoreHash = '';
  let lastSnap = null;
  let listTargetTerm = loadListTarget();
  let listTargetTermNorm = normText(listTargetTerm);
  let lastListMatchHref = '';
  let lastListMatchId = '';
  let lastListActivateAt = 0;
  let lastListActivatedHref = '';
  let listTargetRetryTimer = null;
  let listTargetRetryCount = 0;
  let iceMode = 'stun';
  let pendingTurnFallback = false;
  const peerReplayTs = new Map(); // peerId -> ts for replay cooldown
  const peerSeen = new Map();     // peerId -> ts last seen (online)
  const peers = new Map();        // peerId -> { name, lastSeen, online }
  let lastReplayTs = 0;
  let actionHandlers = new Map();
  let peerJoinHandlers = new Set();
  let peerLeaveHandlers = new Set();
  let outboundQueue = [];
  let reconnectTimer = null;
  let reconnectDelay = 1500;
  let uiApi = null;
  let wakeLock = null;
  let keepAliveTimer = null;
  let silentVideo = null;

  /**********************
   *       HELPERS      *
   **********************/
  const $ = (sel, root=document) => root.querySelector(sel);

  function save(){ try { localStorage.setItem(LSKEY, JSON.stringify(S)); } catch(_){ } }

  function sanitizeSignalingMode(raw){
    const val = String(raw || '').trim().toLowerCase();
    return SIGNALING_ALLOWED.has(val) ? val : '';
  }

  function readConnectionUrlParams(){
    try {
      const p = new URL(window.location.href).searchParams;
      return {
        room: (p.get('room') || '').trim(),
        pass: p.get('pass') || '',
        name: (p.get('name') || '').trim(),
        signal: sanitizeSignalingMode(p.get('signal') || ''),
        autojoin: (p.get('autojoin') || '').trim()
      };
    } catch(_) {
      return {};
    }
  }

  function loadSettings(){
    try{
      const rawStored = localStorage.getItem(LSKEY) || localStorage.getItem('fs2arduino.settings.v12') || '{}';
      const raw = JSON.parse(rawStored || '{}');
      const next = Object.assign({}, DEFAULTS, raw);
      const qp = readConnectionUrlParams();
      if (qp.room) next.trRoom = qp.room;
      if (qp.pass) next.trPass = qp.pass;
      if (qp.name) next.username = qp.name;
      if (qp.signal) next.signalingMode = qp.signal;
      if (qp.autojoin === '1' || qp.autojoin === 'true') next.autoConnect = true;
      next.signalingMode = sanitizeSignalingMode(next.signalingMode) || SIGNALING_DEFAULT;
      return next;
    }catch(_){
      return Object.assign({}, DEFAULTS);
    }
  }

  function normText(input){
    return String(input || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function loadListTarget(){
    try { return String(localStorage.getItem(LIST_TARGET_KEY) || '').trim(); } catch(_){ return ''; }
  }

  function saveListTarget(term){
    try {
      const value = String(term || '').trim();
      if (value) localStorage.setItem(LIST_TARGET_KEY, value);
      else localStorage.removeItem(LIST_TARGET_KEY);
    } catch(_){}
  }

  function getName(selector){
    const el = $(selector);
    if (!el) return '';
    return el.tagName === 'IMG' ? (el.getAttribute('alt') || '') : (el.textContent || '').trim();
  }

  function parseScorePairFrom(wrapper){
    if (!wrapper) return {home:null, away:null};
    const spans = wrapper.querySelectorAll('span');
    const home = spans[0] ? parseInt(spans[0].textContent,10) : null;
    const away = spans[2] ? parseInt(spans[2].textContent,10) : null;
    return {home, away};
  }

  function hasScorePair(wrapper){
    const pair = parseScorePairFrom(wrapper);
    return Number.isInteger(pair.home) && Number.isInteger(pair.away);
  }

  function getFlashscoreDomMatchState(){
    if (getSite() !== 'flashscore') return '';

    const scoreWrapper = $(SEL.scoreWrapper);
    const fixedScoreWrapper = $(SEL.fixedScoreWrapper);
    if ($(SEL.liveWrapper) || $(SEL.fixedWrapper)) return 'live';

    const scoreHasValue = hasScorePair(scoreWrapper) || hasScorePair(fixedScoreWrapper);
    if (scoreHasValue) return 'ended';

    return '';
  }

  function parseScoreText(text){
    const num = parseInt(String(text || '').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(num) ? num : null;
  }

  function isFinalState(state){
    const s = String(state || '').toLowerCase().trim();
    if (!s) return false;
    return ['final','finished','ft','end','ended','aet','pen','ft.'].includes(s);
  }

  function isEndedStatusText(text){
    const s = String(text || '').toLowerCase().trim();
    if (!s) return false;
    return /(encerr|final|finished|termin|ended|\bft\b|\baet\b|ap[oó]s\s+prorroga|fim)/i.test(s);
  }

  function isActiveStatusText(text){
    const s = String(text || '').toLowerCase().trim();
    if (!s) return false;
    return /(intervalo|half[\s-]?time|\bht\b|^\d+\s*(?:['’+]|$)|^\d+\+\d+\s*['’]?)/i.test(s);
  }

  function eventTypeFromSummaryRow(row){
    if (!row) return null;
    if (row.querySelector(SEL_EVENTS.redIcon)) return 'redCard';
    if (row.querySelector(SEL_EVENTS.yellowIcon)) return 'yellowCard';
    if (row.querySelector(SEL_EVENTS.substitutionIcon)) return 'substitution';
    const text = normText(row.textContent || '');
    if (text.includes('cartao vermelho') || text.includes('red card')) return 'redCard';
    if (text.includes('cartao amarelo') || text.includes('yellow card')) return 'yellowCard';
    if (text.includes('substituicao') || text.includes('substitution')) return 'substitution';
    return null;
  }

  function sideFromSummaryRow(row){
    if (!row) return null;
    if (row.classList.contains('smv__homeParticipant')) return 'home';
    if (row.classList.contains('smv__awayParticipant')) return 'away';
    return null;
  }

  function extractSummaryRuleEvents(){
    if (getSite() !== 'flashscore') return [];
    const rows = Array.from(document.querySelectorAll(SEL_EVENTS.row));
    if (!rows.length) return [];
    const out = [];
    const seen = new Set();
    for (const row of rows) {
      const type = eventTypeFromSummaryRow(row);
      if (!type) continue;
      const side = sideFromSummaryRow(row);
      if (!side) continue;
      const text = String(row.textContent || '').replace(/\s+/g, ' ').trim();
      const minute = (row.querySelector(SEL_EVENTS.minute)?.textContent || '').replace(/\s+/g, '').trim();
      const player = (row.querySelector(SEL_EVENTS.player)?.textContent || '').replace(/\s+/g, ' ').trim();
      const playerOut = (row.querySelector(SEL_EVENTS.subOut)?.textContent || '').replace(/\s+/g, ' ').trim();
      const id = `${minute || '-'}:${side}:${type}:${normText(player || text).slice(0, 80)}:${normText(playerOut).slice(0, 80)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, side, type, minute, player, playerOut, text });
    }
    return out;
  }

  function cardHash(cards){
    if (!Array.isArray(cards) || !cards.length) return '';
    return cards.map((ev)=>`${ev.side}:${ev.type}:${ev.id}`).sort().join('|');
  }

  function getMatchStatusText(){
    const statusEl = $(SEL.statusText);
    if (statusEl && statusEl.textContent) return statusEl.textContent.trim();
    const fallback = document.querySelector('.detailScore__status, .fixedScore__status');
    return fallback?.textContent?.trim() || '';
  }

  function splitSearchTokens(raw){
    const cleaned = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return [];
    const sepRe = /\s+(?:x|vs|v|@)\s+|\s+-\s+/i;
    if (sepRe.test(cleaned)) {
      return cleaned.split(sepRe).map(normText).filter(Boolean);
    }
    const single = normText(cleaned);
    return single ? [single] : [];
  }

  function getListRows(){
    return Array.from(document.querySelectorAll(SEL_LIST.row));
  }

  function getListRowNames(row){
    const homeName = (row?.querySelector(SEL_LIST.homeName)?.textContent || '').trim();
    const awayName = (row?.querySelector(SEL_LIST.awayName)?.textContent || '').trim();
    return {
      homeName,
      awayName,
      homeNorm: normText(homeName),
      awayNorm: normText(awayName)
    };
  }

  function isListRowEnded(row, homeScoreEl, awayScoreEl){
    if (!row) return false;
    const stageText = row.querySelector(SEL_LIST.stage)?.textContent || '';
    if (isEndedStatusText(stageText)) return true;
    const homeState = homeScoreEl?.getAttribute('data-state') || homeScoreEl?.dataset?.state || '';
    const awayState = awayScoreEl?.getAttribute('data-state') || awayScoreEl?.dataset?.state || '';
    if (isFinalState(homeState) || isFinalState(awayState)) return true;
    if (homeScoreEl?.className?.includes('wcl-isFinal') || awayScoreEl?.className?.includes('wcl-isFinal')) return true;
    return false;
  }

  function isLiveRow(row){
    if (!row) return false;
    if (row.classList.contains('event__match--live')) return true;
    const scores = row.querySelectorAll('.event__score');
    for (const el of scores) {
      const state = (el.getAttribute('data-state') || '').toLowerCase();
      if (state === 'live') return true;
      if ((el.className || '').includes('wcl-isLive')) return true;
    }
    return false;
  }

  function rowMatchesTokens(row, tokens){
    if (!row || !tokens || !tokens.length) return false;
    const names = getListRowNames(row);
    if (!names.homeNorm && !names.awayNorm) return false;
    if (tokens.length >= 2) {
      let hit = 0;
      for (const token of tokens) {
        if (!token) continue;
        if (names.homeNorm.includes(token) || names.awayNorm.includes(token)) hit += 1;
      }
      return hit >= 2;
    }
    const t = tokens[0];
    return t && (names.homeNorm.includes(t) || names.awayNorm.includes(t));
  }

  function findListRowByTokens(tokens){
    const rows = getListRows();
    if (!rows.length) return null;
    const matches = [];
    for (const row of rows) {
      if (rowMatchesTokens(row, tokens)) matches.push(row);
    }
    if (!matches.length) return null;
    const live = matches.find(isLiveRow);
    return live || matches[0];
  }

  function findListRowByHref(href){
    if (!href) return null;
    const rows = getListRows();
    for (const row of rows) {
      const link = row.querySelector(SEL_LIST.link);
      if (link && link.href === href) return row;
    }
    return null;
  }

  function findListRowByNames(homeName, awayName){
    const homeNorm = normText(homeName);
    const awayNorm = normText(awayName);
    if (!homeNorm && !awayNorm) return null;
    const tokens = [];
    if (homeNorm) tokens.push(homeNorm);
    if (awayNorm && awayNorm !== homeNorm) tokens.push(awayNorm);
    if (!tokens.length) return null;
    return findListRowByTokens(tokens);
  }

  function currentMatchMatchesTarget(tokens){
    if (!tokens || !tokens.length) return false;
    const homeNorm = normText(getName(SEL.homeName));
    const awayNorm = normText(getName(SEL.awayName));
    if (!homeNorm && !awayNorm) return false;
    if (tokens.length >= 2) {
      let hit = 0;
      for (const token of tokens) {
        if (!token) continue;
        if (homeNorm.includes(token) || awayNorm.includes(token)) hit += 1;
      }
      return hit >= 2;
    }
    const t = tokens[0];
    return t && (homeNorm.includes(t) || awayNorm.includes(t));
  }

  function extractListSnapshot(row){
    if (!row) return null;
    const names = getListRowNames(row);
    const homeScoreEl = row.querySelector(SEL_LIST.homeScore);
    const awayScoreEl = row.querySelector(SEL_LIST.awayScore);
    const homeScore = parseScoreText(homeScoreEl?.textContent);
    const awayScore = parseScoreText(awayScoreEl?.textContent);
    const statusText = (row.querySelector(SEL_LIST.stage)?.textContent || '').trim();
    const ended = isListRowEnded(row, homeScoreEl, awayScoreEl);
    const link = row.querySelector(SEL_LIST.link);
    return {
      homeName: names.homeName,
      awayName: names.awayName,
      homeScore,
      awayScore,
      statusText,
      matchStatus: statusText,
      href: link?.href || '',
      ended
    };
  }

  function getListFallbackSnapshot(){
    if (getSite() !== 'flashscore') return null;
    let row = null;
    const tokens = splitSearchTokens(listTargetTerm);
    if (tokens.length) row = findListRowByTokens(tokens);
    if (!row && lastListMatchHref) row = findListRowByHref(lastListMatchHref);
    if (!row && lastListMatchId) {
      const el = document.getElementById(lastListMatchId);
      if (el && el.matches && el.matches(SEL_LIST.row)) row = el;
    }
    if (!row && lastSnap) row = findListRowByNames(lastSnap.homeName, lastSnap.awayName);
    if (!row) return null;
    const snap = extractListSnapshot(row);
    if (snap) {
      if (row.id) lastListMatchId = row.id;
      if (snap.href) lastListMatchHref = snap.href;
    }
    return snap;
  }

  function isMatchPage(){
    return /\/(jogo|match)\//i.test(location.pathname || '');
  }

  function maybeActivateListMatch(reason){
    if (getSite() !== 'flashscore') return false;
    const tokens = splitSearchTokens(listTargetTerm);
    if (!tokens.length) return false;
    if (isMatchPage() && currentMatchMatchesTarget(tokens)) return false;
    const now = Date.now();
    if (now - lastListActivateAt < 2500) return false;
    const row = findListRowByTokens(tokens);
    if (!row) return false;
    const snap = extractListSnapshot(row);
    if (!snap || !snap.href) return false;
    if (snap.href === lastListActivatedHref && now - lastListActivateAt < 8000) return false;
    lastListActivatedHref = snap.href;
    lastListActivateAt = now;
    if (row.id) lastListMatchId = row.id;
    if (snap.href) lastListMatchHref = snap.href;
    try { row.scrollIntoView({ block:'center' }); } catch(_){}
    const link = row.querySelector(SEL_LIST.link);
    if (link) {
      try { link.click(); } catch(_){
        try { window.location.href = snap.href; } catch(_){}
      }
      uiApi?.log?.(`Ativando jogo pela lista (${reason || 'auto'}): ${snap.homeName} x ${snap.awayName}`);
      return true;
    }
    return false;
  }

  function scheduleListActivation(reason){
    if (listTargetRetryTimer) {
      clearTimeout(listTargetRetryTimer);
      listTargetRetryTimer = null;
    }
    listTargetRetryCount = 0;
    const attempt = ()=>{
      listTargetRetryTimer = null;
      if (!listTargetTerm) return;
      if (maybeActivateListMatch(reason || 'target')) return;
      listTargetRetryCount += 1;
      if (listTargetRetryCount < 8) {
        listTargetRetryTimer = setTimeout(attempt, 800);
      }
    };
    attempt();
  }

  function setListTargetTerm(term, reason){
    const cleaned = String(term || '').trim();
    listTargetTerm = cleaned;
    listTargetTermNorm = normText(cleaned);
    saveListTarget(listTargetTerm);
    if (cleaned) uiApi?.log?.(`Alvo da lista: ${cleaned} (${reason || 'externo'})`);
    else {
      if (listTargetRetryTimer) {
        clearTimeout(listTargetRetryTimer);
        listTargetRetryTimer = null;
      }
      uiApi?.log?.('Alvo da lista limpo');
    }
    scheduleCheck();
    if (cleaned) scheduleListActivation('target');
  }

  function snapshot(){
    const site = getSite();
    if (site === 'espn') {
      const homeNameEl = $(SEL_ESPN.homeName);
      const awayNameEl = $(SEL_ESPN.awayName);
      const homeScoreEl = $(SEL_ESPN.homeScore);
      const awayScoreEl = $(SEL_ESPN.awayScore);

      if (!homeNameEl) uiApi?.log?.('homeNameEl not found');
      if (!awayNameEl) uiApi?.log?.('awayNameEl not found');
      if (!homeScoreEl) uiApi?.log?.('homeScoreEl not found');
      if (!awayScoreEl) uiApi?.log?.('awayScoreEl not found');

      const homeName = homeNameEl?.textContent || '';
      const awayName = awayNameEl?.textContent || '';
      const homeScore = parseInt(homeScoreEl?.textContent, 10);
      const awayScore = parseInt(awayScoreEl?.textContent, 10);
      
      uiApi?.log?.(`Snap ESPN: ${homeName} ${homeScore} vs ${awayName} ${awayScore}`);

      return {homeName, awayName, homeScore, awayScore, ended: false, cards: []};
    }

    let homeName = getName(SEL.homeName);
    let awayName = getName(SEL.awayName);
    let statusText = getMatchStatusText();
    const domMatchState = getFlashscoreDomMatchState();
    let ended = isEndedStatusText(statusText) || (domMatchState === 'ended' && !isActiveStatusText(statusText));
    if (domMatchState === 'live') ended = false;

    let home = null;
    let away = null;
    const wrappers = [
      $(SEL.liveWrapper),
      $(SEL.scoreWrapper),
      $(SEL.fixedWrapper),
      $(SEL.fixedScoreWrapper)
    ];
    for (const wrapper of wrappers) {
      const pair = parseScorePairFrom(wrapper);
      if (Number.isInteger(pair.home) && !Number.isInteger(home)) home = pair.home;
      if (Number.isInteger(pair.away) && !Number.isInteger(away)) away = pair.away;
      if (Number.isInteger(home) && Number.isInteger(away)) break;
    }

    if (!Number.isInteger(home) || !Number.isInteger(away)){
      const listSnap = getListFallbackSnapshot();
      if (listSnap) {
        if (!homeName && listSnap.homeName) homeName = listSnap.homeName;
        if (!awayName && listSnap.awayName) awayName = listSnap.awayName;
        if (!Number.isInteger(home) && Number.isInteger(listSnap.homeScore)) home = listSnap.homeScore;
        if (!Number.isInteger(away) && Number.isInteger(listSnap.awayScore)) away = listSnap.awayScore;
        if (!statusText && listSnap.statusText) statusText = listSnap.statusText;
        if (domMatchState !== 'live' && listSnap.ended) ended = true;
      }
    }

    const cards = extractSummaryRuleEvents();
    return {homeName, awayName, homeScore:home, awayScore:away, statusText, matchStatus: statusText, ended, cards};
  }

  function snapHasData(snap){
    if (!snap || typeof snap !== 'object') return false;
    const hasName = String(snap.homeName || snap.awayName || '').trim().length > 0;
    const hasScore = Number.isInteger(snap.homeScore) || Number.isInteger(snap.awayScore);
    return hasName || hasScore;
  }

  function generateId(bytes = 16){
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b=> b.toString(16).padStart(2,'0')).join('');
  }

  function ensureStableId(){
    try {
      const stored = localStorage.getItem(STABLE_ID_STORAGE)
        || localStorage.getItem(FLOWGATE_ID_FALLBACK)
        || localStorage.getItem(TRYSTERO_ID_FALLBACK);
      if (stored && /^[0-9a-f]{16,128}$/i.test(stored)) return stored.toLowerCase();
    } catch(_){}
    const hex = generateId(16);
    try { localStorage.setItem(STABLE_ID_STORAGE, hex); } catch(_){}
    return hex;
  }

  function stableSelfId(){
    const hex = ensureStableId();
    return `sid-${(hex||'').slice(0,12)}`;
  }

  function sanitizeId(raw){
    return String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'room';
  }

  function hashString(input){
    const str = String(input || '');
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash.toString(16);
  }

  function buildRoomHostId(roomId, password){
    const base = sanitizeId(roomId);
    const passHash = password ? hashString(password) : 'nopass';
    let hostId = `room-${base}-${passHash}`;
    if (hostId.length > 50) hostId = hostId.slice(0, 50);
    return hostId;
  }

  function buildHostIdWithSuffix(baseId, suffix){
    const cleanSuffix = suffix ? `-${suffix}` : '';
    const maxLen = 50;
    const base = String(baseId || '');
    if (!cleanSuffix) return base.slice(0, maxLen);
    const parts = base.split('-');
    if (parts.length >= 3) {
      const tail = parts.pop();
      const head = parts.join('-');
      const withSuffix = `${head}${cleanSuffix}-${tail}`;
      if (withSuffix.length <= maxLen) return withSuffix;
      const keep = Math.max(1, maxLen - cleanSuffix.length - 1 - tail.length);
      return `${head.slice(0, keep)}${cleanSuffix}-${tail}`;
    }
    const keep = Math.max(1, maxLen - cleanSuffix.length);
    return `${base.slice(0, keep)}${cleanSuffix}`;
  }

  function resolveHostIdByIndex(idx){
    const suffix = HOST_ID_SUFFIXES[idx] ?? HOST_ID_SUFFIXES[0];
    return buildHostIdWithSuffix(roomHostId, suffix);
  }

  function advanceHostId(reason){
    if (HOST_ID_SUFFIXES.length < 2) return false;
    const nextIndex = (hostIdIndex + 1) % HOST_ID_SUFFIXES.length;
    const nextId = resolveHostIdByIndex(nextIndex);
    if (!nextId || nextId === activeHostId) return false;
    hostIdIndex = nextIndex;
    activeHostId = nextId;
    uiApi?.log?.(`Host PeerJS alternado: ${activeHostId.slice(0, 12)} (${reason || 'retry'})`);
    return true;
  }

  function buildRoomKey(roomId, password){
    return buildRoomHostId(roomId, password);
  }

  function firebaseRoomPath(roomKey){
    return `${FIREBASE_ROOM_ROOT}/${roomKey}`;
  }

  async function ensureFirebase(){
    if (firebaseApi && firebaseDb) return firebaseApi;
    if (firebaseInitPromise) return firebaseInitPromise;
    firebaseInitPromise = (async ()=>{
      try {
        const [appMod, authMod, dbMod] = await Promise.all([
          import('https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js'),
          import('https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js'),
          import('https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js')
        ]);
        const apps = (typeof appMod.getApps === 'function') ? appMod.getApps() : [];
        const app = apps && apps.length ? appMod.getApp() : appMod.initializeApp(FIREBASE_CONFIG);
        const auth = authMod.getAuth(app);
        if (!auth.currentUser) await authMod.signInAnonymously(auth);
        const db = dbMod.getDatabase(app);
        firebaseDb = db;
        firebaseApi = {
          ref: dbMod.ref,
          set: dbMod.set,
          push: dbMod.push,
          remove: dbMod.remove,
          onChildAdded: dbMod.onChildAdded,
          onChildChanged: dbMod.onChildChanged,
          onChildRemoved: dbMod.onChildRemoved,
          onDisconnect: dbMod.onDisconnect,
          query: dbMod.query,
          orderByChild: dbMod.orderByChild,
          startAt: dbMod.startAt,
          limitToLast: dbMod.limitToLast,
          db
        };
        return firebaseApi;
      } catch (e) {
        firebaseInitPromise = null;
        uiApi?.log?.(`Firebase indisponivel: ${e?.message || e}`);
        return null;
      }
    })();
    return firebaseInitPromise;
  }

  function isFirebasePresenceStale(val, now = Date.now()){
    const t = Number(val?.t || 0);
    return !!(t && (now - t) > FIREBASE_PRESENCE_TTL_MS);
  }

  function rememberFirebaseMessage(id){
    if (!id) return false;
    if (firebaseSeenMessages.has(id)) return false;
    firebaseSeenMessages.add(id);
    firebaseSeenQueue.push(id);
    if (firebaseSeenQueue.length > FIREBASE_SEEN_MAX) {
      const old = firebaseSeenQueue.shift();
      if (old) firebaseSeenMessages.delete(old);
    }
    return true;
  }

  function resetFirebaseSeen(){
    firebaseSeenMessages = new Set();
    firebaseSeenQueue = [];
  }

  function clearFirebaseCleanupTimers(){
    for (const timer of firebaseCleanupTimers) clearTimeout(timer);
    firebaseCleanupTimers.clear();
  }

  function stopFirebaseActionListeners(){
    for (const unsub of firebaseActionUnsubs.values()) {
      try { unsub(); } catch(_){}
    }
    firebaseActionUnsubs = new Map();
  }

  function stopFirebasePresenceListeners(){
    for (const unsub of firebasePresenceUnsubs) {
      try { unsub(); } catch(_){}
    }
    firebasePresenceUnsubs = [];
  }

  function teardownFirebase(){
    firebaseConnected = false;
    stopFirebaseActionListeners();
    stopFirebasePresenceListeners();
    clearFirebaseCleanupTimers();
    try { firebasePresenceOnDisconnect?.cancel?.(); } catch(_){}
    firebasePresenceOnDisconnect = null;
    if (firebasePresenceSelfRef && firebaseApi?.remove) {
      try { firebaseApi.remove(firebasePresenceSelfRef); } catch(_){}
    }
    firebasePresenceSelfRef = null;
    firebaseRoomKey = '';
    firebaseSessionStart = 0;
    resetFirebaseSeen();
  }

  function scheduleFirebaseCleanup(action, key){
    if (!firebaseApi || !firebaseRoomKey || !key) return;
    const api = firebaseApi;
    const ref = api.ref(api.db, `${firebaseRoomPath(firebaseRoomKey)}/actions/${action}/${key}`);
    const timer = setTimeout(()=>{
      try {
        const remove = api.remove(ref);
        if (remove && typeof remove.catch === 'function') remove.catch(()=>{});
      } catch(_){}
    }, FIREBASE_MESSAGE_TTL_MS);
    firebaseCleanupTimers.add(timer);
  }

  function markFirebasePeerOffline(peerId){
    if (!peerId) return;
    const raw = String(peerId);
    const cur = peers.get(raw);
    if (!cur) return;
    peers.set(raw, { ...cur, online:false, lastSeen: Date.now() });
    peerSeen.delete(raw);
    peerReplayTs.delete(raw);
    uiApi?.renderPeers?.();
    notifyPeerLeave(raw);
  }

  function ensureFirebaseActionListener(action){
    if (!firebaseConnected || !firebaseApi || !firebaseRoomKey) return;
    if (firebaseActionUnsubs.has(action)) return;
    const api = firebaseApi;
    const baseRef = api.ref(api.db, `${firebaseRoomPath(firebaseRoomKey)}/actions/${action}`);
    const startAtTs = (firebaseSessionStart || Date.now()) - FIREBASE_SESSION_GRACE_MS;
    const queryRef = api.query(baseRef, api.orderByChild('ts'), api.startAt(startAtTs), api.limitToLast(100));
    const unsub = api.onChildAdded(queryRef, (snap)=>{
      const data = snap.val();
      if (!data || data.__flowgate !== FLOWGATE_PROTO) return;
      const id = snap.key || data.id || '';
      if (!rememberFirebaseMessage(id)) return;
      const from = String(data.from || '');
      if (from && from === selfPeerId()) return;
      const target = data.target ? String(data.target) : '';
      const sid = stableSelfId();
      if (target && target !== String(selfPeerId()) && target !== sid) return;
      handleEnvelope(data);
    });
    firebaseActionUnsubs.set(action, unsub);
  }

  function ensureFirebasePresenceListener(){
    if (!firebaseConnected || !firebaseApi || !firebaseRoomKey) return;
    if (firebasePresenceUnsubs.length) return;
    const api = firebaseApi;
    const baseRef = api.ref(api.db, `${firebaseRoomPath(firebaseRoomKey)}/presence`);
    const handleUpsert = (snap)=>{
      const val = snap.val();
      if (!val) return;
      const peerId = String(val.peerId || snap.key || '');
      if (!peerId) return;
      const sid = String(val.sid || peerId || '');
      if (peerId === selfPeerId() || sid === stableSelfId()) return;
      if (isFirebasePresenceStale(val)) {
        markFirebasePeerOffline(sid || peerId);
        try {
          const staleRef = api.ref(api.db, `${firebaseRoomPath(firebaseRoomKey)}/presence/${snap.key}`);
          const remove = api.remove(staleRef);
          if (remove && typeof remove.catch === 'function') remove.catch(()=>{});
        } catch(_){}
        return;
      }
      dispatchAction('presence', { ...val, peerId }, peerId);
    };
    const handleRemove = (snap)=>{
      const peerId = String(snap.key || '');
      if (peerId && peerId !== selfPeerId()) markFirebasePeerOffline(peerId);
    };
    firebasePresenceUnsubs = [
      api.onChildAdded(baseRef, handleUpsert),
      api.onChildChanged(baseRef, handleUpsert),
      api.onChildRemoved(baseRef, handleRemove)
    ];
  }

  function firebaseSendPresence(payload){
    if (!firebaseConnected || !firebaseApi || !firebaseRoomKey) return false;
    const api = firebaseApi;
    const key = String(selfPeerId() || stableSelfId());
    const ref = api.ref(api.db, `${firebaseRoomPath(firebaseRoomKey)}/presence/${key}`);
    firebasePresenceSelfRef = ref;
    if (!firebasePresenceOnDisconnect) {
      try {
        firebasePresenceOnDisconnect = api.onDisconnect(ref);
        firebasePresenceOnDisconnect.remove();
      } catch(_){}
    }
    const data = { ...(payload || {}) };
    data.peerId = key;
    data.sid = data.sid || stableSelfId();
    data.t = Date.now();
    try {
      const write = api.set(ref, data);
      if (write && typeof write.catch === 'function') {
        write.catch((err)=> uiApi?.log?.(`Firebase presence falhou: ${err?.message || err}`));
      }
    } catch(err) {
      uiApi?.log?.(`Firebase presence falhou: ${err?.message || err}`);
      return false;
    }
    return true;
  }

  function firebaseSendAction(action, payload, targetPeerId){
    if (!firebaseConnected || !firebaseApi || !firebaseRoomKey) return false;
    const api = firebaseApi;
    const envelope = buildEnvelope(action, payload, targetPeerId);
    const baseRef = api.ref(api.db, `${firebaseRoomPath(firebaseRoomKey)}/actions/${action}`);
    const msgRef = api.push(baseRef);
    const msgKey = msgRef?.key || '';
    if (msgKey) envelope.id = msgKey;
    try {
      const write = api.set(msgRef, envelope);
      if (write && typeof write.catch === 'function') {
        write.catch((err)=> uiApi?.log?.(`Firebase send falhou: ${err?.message || err}`));
      }
    } catch(err) {
      uiApi?.log?.(`Firebase send falhou: ${err?.message || err}`);
      return false;
    }
    if (msgKey) scheduleFirebaseCleanup(action, msgKey);
    return true;
  }

  /**********************
   *   ANTI-SUSPENSAO   *
   **********************/
  async function ensureWakeLock(){
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch(e){
      uiApi?.log?.('WakeLock falhou: '+(e?.message||e));
    }
  }

  async function releaseWakeLock(){
    try { await wakeLock?.release?.(); } catch(_){}
    wakeLock = null;
  }

  function startKeepAlive(){
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(()=> { /* noop ping */ performance.now(); }, 90000);
  }

  function stopKeepAlive(){
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  function ensureSilentVideo(){
    if (silentVideo) return;
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (ctx) { ctx.fillStyle = '#000'; ctx.fillRect(0,0,1,1); }
    const stream = canvas.captureStream ? canvas.captureStream(1) : null;
    if (!stream) return;
    const v = document.createElement('video');
    v.muted = true; v.loop = true; v.playsInline = true; v.srcObject = stream;
    Object.assign(v.style, { position:'fixed', width:'1px', height:'1px', opacity:'0', pointerEvents:'none', bottom:'0', left:'0' });
    document.body.appendChild(v);
    v.play().catch(()=>{});
    silentVideo = { video:v, stream };
  }

  function stopSilentVideo(){
    if (silentVideo?.stream) {
      try { silentVideo.stream.getTracks().forEach(t=> t.stop()); } catch(_){}
    }
    if (silentVideo?.video) {
      try { silentVideo.video.remove(); } catch(_){}
    }
    silentVideo = null;
  }

  function syncAntiSuspend(){
    const allow = !!S.noSleep;
    if (allow) {
      ensureWakeLock();
      startKeepAlive();
      ensureSilentVideo();
      uiApi?.setNoSleepStatus?.('ativo');
    } else {
      releaseWakeLock();
      stopKeepAlive();
      stopSilentVideo();
      uiApi?.setNoSleepStatus?.('inativo');
    }
  }

  /**********************
   *   PEERJS (FLOWGATE) *
   **********************/
  const FLOWGATE_PROTO = 'flowgate-peerjs-v1';
  const SYS_PEER_JOIN = '__sys:peer-join';
  const SYS_PEER_LEAVE = '__sys:peer-leave';
  const OUTBOUND_QUEUE_MAX = 120;

  function selfPeerId(){
    return (peer && peer.id) ? String(peer.id) : stableSelfId();
  }

  function buildEnvelope(action, payload, targetPeerId){
    const fromId = selfPeerId();
    return {
      __flowgate: FLOWGATE_PROTO,
      action,
      payload,
      target: targetPeerId || null,
      from: fromId,
      sid: stableSelfId(),
      ts: Date.now()
    };
  }

  function sendEnvelope(envelope){
    if (!hostConn || !hostConn.open) return false;
    try { hostConn.send(envelope); return true; } catch { return false; }
  }

  function dispatchAction(action, payload, fromPeerId){
    const handlers = actionHandlers.get(action);
    if (!handlers) return;
    for (const cb of handlers) {
      try { cb(payload, fromPeerId); } catch(_){}
    }
  }

  function makeActionPeer(action){
    let handlers = actionHandlers.get(action);
    if (!handlers) {
      handlers = new Set();
      actionHandlers.set(action, handlers);
    }
    const send = (payload, targetPeerId)=> {
      const envelope = buildEnvelope(action, payload, targetPeerId);
      if (!sendEnvelope(envelope)) {
        outboundQueue.push(envelope);
        if (outboundQueue.length > OUTBOUND_QUEUE_MAX) outboundQueue.shift();
      }
    };
    const get = (cb)=> { if (typeof cb === 'function') handlers.add(cb); };
    return [send, get];
  }

  function makeActionFirebase(action){
    let handlers = actionHandlers.get(action);
    if (!handlers) {
      handlers = new Set();
      actionHandlers.set(action, handlers);
    }
    if (action === 'presence') ensureFirebasePresenceListener();
    else ensureFirebaseActionListener(action);
    const send = (payload, targetPeerId)=> {
      if (action === 'presence') return firebaseSendPresence(payload);
      return firebaseSendAction(action, payload, targetPeerId);
    };
    const get = (cb)=> { if (typeof cb === 'function') handlers.add(cb); };
    return [send, get];
  }

  function makeAction(action){
    return activeTransport === 'firebase' ? makeActionFirebase(action) : makeActionPeer(action);
  }

  function flushOutbound(){
    if (!hostConn || !hostConn.open) return;
    while (outboundQueue.length) {
      const env = outboundQueue.shift();
      sendEnvelope(env);
    }
  }

  function notifyPeerJoin(peerId){
    if (!peerId) return;
    for (const cb of peerJoinHandlers) {
      try { cb(peerId); } catch(_){}
    }
  }

  function notifyPeerLeave(peerId){
    if (!peerId) return;
    for (const cb of peerLeaveHandlers) {
      try { cb(peerId); } catch(_){}
    }
  }

  function handleEnvelope(data){
    if (!data || data.__flowgate !== FLOWGATE_PROTO) return;
    const action = data.action;
    if (!action) return;
    if (action === SYS_PEER_JOIN) {
      notifyPeerJoin(data?.payload?.peerId);
      return;
    }
    if (action === SYS_PEER_LEAVE) {
      notifyPeerLeave(data?.payload?.peerId);
      return;
    }
    dispatchAction(action, data.payload, data.from);
  }

  function scheduleReconnect(){
    if (activeTransport !== 'peerjs') return;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(()=> {
      reconnectTimer = null;
      connectToHost();
      reconnectDelay = Math.min(reconnectDelay * 1.6, 8000);
    }, reconnectDelay);
  }

  function registerHostConn(conn){
    if (!conn) return;
    hostConn = conn;
    attachPeerConnectionDebug(conn, 'host-conn');
    conn.on('open', ()=> {
      trConnected = true;
      reconnectDelay = 1500;
      uiApi?.setStatus?.(`sala ${S.trRoom} (PeerJS)`);
      uiApi?.log?.(`PeerJS conectado ao host ${activeHostId || roomHostId}.`);
      flushOutbound();
      if (lastSnap) broadcastScore(lastSnap, 'connect');
      else {
        try { lastSnap = snapshot(); broadcastScore(lastSnap, 'connect'); } catch(_){}
      }
    });
    conn.on('data', (data)=> handleEnvelope(data));
    conn.on('close', ()=> {
      hostConn = null;
      trConnected = false;
      uiApi?.setStatus?.('reconectando...');
      uiApi?.log?.('host desconectado, tentando reconectar.');
      advanceHostId('close');
      scheduleReconnect();
    });
    conn.on('error', (err)=> {
      uiApi?.log?.(`erro conexao peerjs: ${err?.type || err?.message || err}`);
      advanceHostId(err?.type || 'error');
      scheduleReconnect();
    });
  }

  function connectToHost(){
    if (activeTransport !== 'peerjs') return;
    if (!peer || !peer.open || !activeHostId) return;
    if (hostConn && hostConn.open) return;
    try {
      const conn = peer.connect(activeHostId, {
        reliable: true,
        serialization: 'json',
        metadata: { room: S.trRoom, sid: stableSelfId() }
      });
      attachPeerConnectionDebug(conn, 'client->host');
      registerHostConn(conn);
    } catch {
      advanceHostId('connect-exception');
      scheduleReconnect();
    }
  }

  function attachPeerConnectionDebug(conn, label){
    if (!conn || conn.__PC_DEBUG_ATTACHED__) return;
    const pc = conn.peerConnection;
    if (!pc) return;
    conn.__PC_DEBUG_ATTACHED__ = true;
    const prefix = `PC ${label}`;
    let candCount = 0;
    const maxCand = 8;
    pc.addEventListener('iceconnectionstatechange', ()=>{
      uiApi?.log?.(`${prefix} iceState=${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') requestTurnFallback('ice-failed');
    });
    pc.addEventListener('connectionstatechange', ()=>{
      uiApi?.log?.(`${prefix} connState=${pc.connectionState}`);
    });
    pc.addEventListener('signalingstatechange', ()=>{
      uiApi?.log?.(`${prefix} signaling=${pc.signalingState}`);
    });
    pc.addEventListener('icecandidate', (ev)=>{
      const cand = ev?.candidate?.candidate || '';
      if (!cand) {
        uiApi?.log?.(`${prefix} icecandidate=end`);
        return;
      }
      if (candCount >= maxCand) return;
      candCount += 1;
      const typMatch = cand.match(/ typ ([a-z0-9]+)/i);
      const typ = typMatch ? typMatch[1] : '?';
      const protoMatch = cand.match(/ udp| tcp/i);
      const proto = protoMatch ? protoMatch[0].trim() : '';
      uiApi?.log?.(`${prefix} icecandidate ${candCount}/${maxCand}: ${typ}${proto ? '/' + proto : ''}`);
    });
  }

  function requestTurnFallback(reason){
    if (pendingTurnFallback || iceMode === 'turn') return;
    pendingTurnFallback = true;
    uiApi?.log?.(`Fallback TURN: ${reason || 'ice'}`);
    reconnectWithTurn(reason);
  }

  function reconnectWithTurn(reason){
    iceMode = 'turn';
    disconnectFlowgate();
    setTimeout(()=> {
      connectFlowgate(`turn-fallback:${reason || 'ice'}`).catch(()=>{});
    }, 250);
  }

  function teardownPeer(){
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectDelay = 1500;
    try { hostConn?.close?.(); } catch(_){}
    hostConn = null;
    try { peer?.destroy?.(); } catch(_){}
    peer = null;
    trConnected = false;
    trSelfId = '';
    actionHandlers = new Map();
    peerJoinHandlers = new Set();
    peerLeaveHandlers = new Set();
    outboundQueue = [];
  }

  function createRoomAdapter(){
    return {
      makeAction,
      onPeerJoin: (cb)=> { if (typeof cb === 'function') peerJoinHandlers.add(cb); },
      onPeerLeave: (cb)=> { if (typeof cb === 'function') peerLeaveHandlers.add(cb); },
      leave: ()=> teardownPeer()
    };
  }
  function startPresenceLoop(name){
    if (!trPresenceSend) return;
    const payload = ()=> ({
      name: name || (S.username||'').trim() || 'bot-flashscore',
      tags: ['flashscore'],
      t: Date.now(),
      sid: stableSelfId(),
      peerId: selfPeerId()
    });

    const announce = (target)=> {
      try { trPresenceSend(payload(), target); } catch(_){}
    };

    announce();
    trRoom?.onPeerJoin?.((peerId)=> announce(peerId));

    if (trPresenceTimer) clearInterval(trPresenceTimer);
    trPresenceTimer = setInterval(()=> announce(), PRESENCE_INTERVAL_MS);
  }

  function stopPresenceLoop(){
    if (trPresenceTimer) clearInterval(trPresenceTimer);
    trPresenceTimer = null;
  }

  function upsertPeer(peerId, data){
    if (!peerId) return;
    const prev = peers.get(peerId) || {};
    const next = { ...prev, ...data, lastSeen: data?.lastSeen || prev.lastSeen || Date.now() };
    peers.set(peerId, next);
    uiApi?.renderPeers?.();
  }

  function broadcastScore(snap, metaReason, targetPeer){
    if (!trConnected || !trScoreSend) return;
    if (!snapHasData(snap)) return;
    const payload = {
      homeName: snap.homeName || '',
      awayName: snap.awayName || '',
      homeScore: Number.isFinite(snap.homeScore) ? snap.homeScore : null,
      awayScore: Number.isFinite(snap.awayScore) ? snap.awayScore : null,
      statusText: String(snap.statusText || snap.matchStatus || '').trim(),
      matchStatus: String(snap.matchStatus || snap.statusText || '').trim(),
      ended: !!snap.ended,
      cards: Array.isArray(snap.cards) ? snap.cards : [],
      ts: Date.now(),
      origin: getSite(),
      reason: metaReason || ''
    };
    const hash = JSON.stringify([payload.homeName, payload.awayName, payload.homeScore, payload.awayScore, payload.ended, payload.matchStatus, cardHash(payload.cards)]);
    const forceSend = targetPeer != null || ['force','connect'].includes(metaReason);
    if (payload.ended && targetPeer == null && hash === lastEndedScoreHash && !forceSend) return;
    if (hash === lastScoreHash && !forceSend) return;
    // se for broadcast (sem target), atualiza hash para evitar flood; se for targeted, nao mexe
    if (targetPeer == null) {
      lastScoreHash = hash;
      if (payload.ended) lastEndedScoreHash = hash;
      else lastEndedScoreHash = '';
    }
    try { trScoreSend(payload, targetPeer); } catch(_){}
  }

  function replayScore(reason, peerId){
    const now = Date.now();
    if (peerId) {
      const last = peerReplayTs.get(peerId) || 0;
      if (now - last < 800) return;
      peerReplayTs.set(peerId, now);
    } else {
      if (now - lastReplayTs < 800) return;
      lastReplayTs = now;
    }
    try {
      const snap = lastSnap || snapshot();
      broadcastScore(snap, reason || 'replay', peerId || null);
    } catch(_){}
  }

  function ensureFirstSend(peerId){
    if (!peerId) return;
    const now = Date.now();
    const last = peerSeen.get(peerId) || 0;
    // envia apenas se nunca vimos ou se passou tempo razoavel desde a ultima vez (ex.: reconexao)
    if (now - last < 5000) return;
    peerSeen.set(peerId, now);
    upsertPeer(peerId, { online:true, lastSeen: now });
    uiApi?.log?.(`replay para ${String(peerId).slice(0,8)}`);
    replayScore('peer-join', peerId);
  }

  async function connectFlowgate(trigger = 'manual'){
    if (trConnected || trConnecting) return;
    trConnecting = true;
    pendingTurnFallback = false;
    signalingMode = resolveSignalingMode();
    S.signalingMode = signalingMode;
    save();
    const useFirebase = signalingMode === 'firebase';
    iceMode = String(trigger || '').startsWith('turn-fallback:') ? 'turn' : 'stun';
    uiApi?.setStatus?.(useFirebase ? 'conectando firebase...' : 'conectando peerjs...');
    try{
      if (peer || activeTransport === 'firebase') await disconnectFlowgate();

      const roomPass = (S.trPass || '').trim();
      roomSignalKey = buildRoomKey(S.trRoom || DEFAULT_ROOM, roomPass);

      if (useFirebase) {
        const api = await ensureFirebase();
        if (!api) {
          uiApi?.setStatus?.('erro firebase');
          return;
        }
        teardownFirebase();
        activeTransport = 'firebase';
        firebaseConnected = true;
        firebaseRoomKey = roomSignalKey;
        firebaseSessionStart = Date.now();
        resetFirebaseSeen();
      } else {
        if (!peerModule) peerModule = await import('https://esm.run/peerjs');
        PeerCtor = peerModule.Peer || peerModule.default || peerModule;
        if (typeof PeerCtor !== 'function') throw new Error('PeerJS import invalido');
        if (peer) teardownPeer();
        activeTransport = 'peerjs';
        roomHostId = buildRoomHostId(S.trRoom || DEFAULT_ROOM, roomPass);
        hostIdIndex = 0;
        activeHostId = resolveHostIdByIndex(hostIdIndex);
      }

      trRoom = createRoomAdapter();

      const [sendScore] = trRoom.makeAction('fs-score');
      const [sendPresence, getPresence] = trRoom.makeAction('presence');
      trScoreSend = (payload, target)=> sendScore(payload, target);
      trPresenceSend = (payload, target)=> sendPresence(payload, target);
      trSelfId = stableSelfId();

      getPresence((data, peerId)=> {
        const nm = String(data?.name||'peer').trim();
        const sid = data?.sid ? String(data.sid) : String(peerId||'peer').slice(0,6);
        const pid = peerId || sid;
        uiApi?.log?.(`presence ${sid}:${nm}`);
        upsertPeer(pid, { name: nm, online:true, lastSeen: Date.now() });
        ensureFirstSend(pid);
      });
      startPresenceLoop((S.username||'').trim());

      trRoom.onPeerJoin?.((p)=>{
        const pid = p || 'peer';
        uiApi?.log?.(`peer entrou: ${String(pid).slice(0,6)}`);
        upsertPeer(pid, { online:true, lastSeen: Date.now() });
        ensureFirstSend(pid);
      });
      trRoom.onPeerLeave?.((p)=> {
        uiApi?.log?.(`peer saiu: ${String(p||'peer').slice(0,6)}`);
        if (p) {
          peerSeen.delete(p); peerReplayTs.delete(p);
          upsertPeer(p, { online:false, lastSeen: Date.now() });
        }
      });

      if (trScoreHeartbeat) clearInterval(trScoreHeartbeat);
      trScoreHeartbeat = setInterval(()=> {
        if (lastSnap?.ended) return;
        if (lastSnap) broadcastScore(lastSnap, 'heartbeat');
      }, SCORE_HEARTBEAT_MS);

      try { lastSnap = snapshot(); } catch(_){}

      if (useFirebase) {
        trConnected = true;
        trSelfId = stableSelfId();
        uiApi?.setStatus?.(`sala ${S.trRoom} (Firebase)`);
        uiApi?.log?.(`Firebase conectado na sala ${S.trRoom}.`);
        if (lastSnap) broadcastScore(lastSnap, 'connect');
        else {
          try { lastSnap = snapshot(); broadcastScore(lastSnap, 'connect'); } catch(_){}
        }
        return;
      }

      peer = new PeerCtor({
        host: PEERJS_SERVER_HOST,
        port: PEERJS_SERVER_PORT,
        path: PEERJS_SERVER_PATH,
        key: PEERJS_SERVER_KEY,
        secure: true,
        debug: 2,
        config: { iceServers: (ICE_CONFIGS[iceMode] || TURN_CONFIG) }
      });
      peer.on('open', (id)=> {
        trSelfId = id || trSelfId;
        uiApi?.log?.(`PeerJS pronto: ${trSelfId || 'sem id'}`);
        connectToHost();
      });
      peer.on('connection', (conn)=> {
        if (conn && conn.peer === activeHostId) registerHostConn(conn);
        else conn?.close?.();
      });
      peer.on('disconnected', ()=> { try { peer.reconnect(); } catch(_){ } });
      peer.on('close', ()=> { trConnected = false; });
      peer.on('error', (err)=> {
        uiApi?.log?.(`erro peerjs: ${err?.type || err?.message || err}`);
        if (!trConnected) uiApi?.setStatus?.('erro peerjs');
      });
    }catch(e){
      uiApi?.setStatus?.(useFirebase ? 'erro firebase' : 'erro peerjs');
      uiApi?.log?.(`Falha ao conectar no ${useFirebase ? 'Firebase' : 'PeerJS'}: `+(e?.message||e));
    }finally{
      trConnecting = false;
    }
  }

  async function disconnectFlowgate(){
    try { trRoom?.leave?.(); } catch(_){}
    if (activeTransport === 'firebase') teardownFirebase();
    trRoom = null;
    roomHostId = '';
    activeHostId = '';
    hostIdIndex = 0;
    roomSignalKey = '';
    activeTransport = '';
    trScoreSend = null;
    trPresenceSend = null;
    trConnected = false;
    trConnecting = false;
    if (trScoreHeartbeat) { clearInterval(trScoreHeartbeat); trScoreHeartbeat = null; }
    stopPresenceLoop();
    lastScoreHash = '';
    lastEndedScoreHash = '';
    peers.clear(); peerSeen.clear(); peerReplayTs.clear();
    uiApi?.renderPeers?.();
    uiApi?.setStatus?.('desconectado');
    uiApi?.log?.('Flowgate desconectado.');
  }

  /**********************
   *  DETECCAO DE SCORE *
   **********************/
  let debounceId = null;
  function scheduleCheck(){
    if (debounceId) clearTimeout(debounceId);
    debounceId = setTimeout(checkScores, 250);
  }

  function checkScores(){
    debounceId = null;
    try{
      const snap = snapshot();
      const hasData = snapHasData(snap);
      if (!Number.isInteger(snap.homeScore) || !Number.isInteger(snap.awayScore)) {
        maybeActivateListMatch('sem-placar');
      }
      if (!hasData) return;

      if (!lastSnap){
        lastSnap = snap;
        const homeScoreDisplay = Number.isInteger(snap.homeScore) ? snap.homeScore : '-';
        const awayScoreDisplay = Number.isInteger(snap.awayScore) ? snap.awayScore : '-';
        uiApi?.log?.(`Memoria iniciada: ${snap.homeName} ${homeScoreDisplay} x ${awayScoreDisplay} ${snap.awayName}`);
        broadcastScore(snap, 'init');
        return;
      }

      const changed = (
        snap.homeName !== lastSnap.homeName ||
        snap.awayName !== lastSnap.awayName ||
        snap.homeScore !== lastSnap.homeScore ||
        snap.awayScore !== lastSnap.awayScore ||
        snap.ended !== lastSnap.ended ||
        cardHash(snap.cards) !== cardHash(lastSnap.cards)
      );

      if (changed){
        const dHome = (Number.isInteger(snap.homeScore) && Number.isInteger(lastSnap.homeScore)) ? (snap.homeScore - lastSnap.homeScore) : null;
        const dAway = (Number.isInteger(snap.awayScore) && Number.isInteger(lastSnap.awayScore)) ? (snap.awayScore - lastSnap.awayScore) : null;
        const deltaTxt = (dHome || dAway) ? ` (delta H:${dHome ?? '-'} A:${dAway ?? '-'})` : '';
        const homeScoreDisplay = Number.isInteger(snap.homeScore) ? snap.homeScore : '-';
        const awayScoreDisplay = Number.isInteger(snap.awayScore) ? snap.awayScore : '-';
        uiApi?.log?.(`Placar: ${snap.homeName} ${homeScoreDisplay} x ${awayScoreDisplay} ${snap.awayName}${deltaTxt}`);
        lastSnap = snap;
        broadcastScore(snap, 'update');
      }
    }catch(e){
      console.error(e);
      uiApi?.log?.('checkScores erro: '+(e?.message||e));
    }
  }

  function startObservers(){
    const site = getSite();
    const wrapperSelector = site === 'espn' ? SEL_ESPN.liveWrapper : SEL.scoreWrapper;
    const live = $(wrapperSelector);
    const fixed = $(SEL.fixedScoreWrapper); // fixedScoreWrapper is only for flashscore
    const opts = { childList:true, subtree:true, attributes:true, attributeFilter:['class', 'data-state'] };
    let listObserved = false;

    if (live){
      const ob1 = new MutationObserver(()=> scheduleCheck());
      ob1.observe(live, opts);
    }
    if (site === 'flashscore' && fixed){
      const ob2 = new MutationObserver(()=> scheduleCheck());
      ob2.observe(fixed, opts);
    }
    if (site === 'flashscore') {
      const listRoot = document.querySelector('#live-table') || document.querySelector('.container__livetable');
      if (listRoot) {
        const ob3 = new MutationObserver(()=> scheduleCheck());
        ob3.observe(listRoot, opts);
        listObserved = true;
      }
    }

    setInterval(scheduleCheck, 1500);
    const listTxt = listObserved ? ' e lista' : '';
    uiApi?.log?.(`Observando nos do placar${listTxt} (${site})`);
  }

  /**********************
   *    LIVE FILTER     *
   **********************/
  function selectLiveTab(){
    const liveTab = document.querySelector('.filters__tab[data-analytics-alias=\"live\"]');
    if (!liveTab) return false;
    if (!liveTab.classList.contains('selected')) liveTab.click();
    return true;
  }

  function ensureLiveFilter(){
    if (getSite() !== 'flashscore') return;
    if (selectLiveTab()) return;
    const ob = new MutationObserver(()=>{
      if (selectLiveTab()) ob.disconnect();
    });
    ob.observe(document.documentElement || document.body, { childList:true, subtree:true });
    setTimeout(()=> ob.disconnect(), 12000);
  }

  /**********************
   *   UI BOOTSTRAP      *
   *   (Shadow DOM)      *
   **********************/
  function buildUI(){
    const existing = document.getElementById('fs2a-root');
    if (existing) existing.remove();

    const root = document.createElement('div');
    root.id = 'fs2a-root';
    root.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;';
    document.body.appendChild(root);

    const shadow = root.attachShadow({ mode:'open' });

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css';
    shadow.appendChild(link);

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .fs2a-card { width: 640px; max-width: calc(100vw - 24px); background: rgba(10,10,10,.88); border: 1px solid #2a2a2a; color:#e8ffe8; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
      .btn-dark { background:#2b2b2b; border-color:#3a3a3a; }
      .btn-dark:hover { background:#333; border-color:#4a4a4a; }
      .form-control, .form-select { background:#2a2a2a; border-color:#3a3a3a; color:#e8ffe8; }
      .form-control:focus, .form-select:focus { background:#2a2a2a; color:#e8ffe8; border-color:#6c757d; box-shadow:none; }
      .form-check-input { background-color:#2a2a2a; border-color:#3a3a2a; }
      .form-check-input:checked { background-color:#10b981; border-color:#10b981; }
      .muted { color:#a3a3a3; }
      .log { max-height: 190px; overflow:auto; background: rgba(0,0,0,.25); border:1px solid #2a2a2a; border-radius: .5rem; padding:.5rem; }
      code { color:#93c5fd; }
      .drag { cursor: move; user-select:none; }
    `;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'card fs2a-card shadow-lg mono';
    wrap.innerHTML = `
      <div class="card-header d-flex align-items-center gap-3 drag">
        <div class="fw-bold">Flashscore -> Flowgate (monitor)</div>
        <div class="ms-2 small" id="fs-status">desconectado</div>

        <div class="ms-auto d-flex align-items-center flex-wrap gap-3">
          <button class="btn btn-outline-secondary btn-sm" id="fs-toggle-log" type="button">Log</button>
          <div class="d-flex align-items-center gap-1 small">
            <label class="form-check-label" for="fs-nosleep-toggle">anti-suspensao</label>
            <input class="form-check-input" type="checkbox" role="switch" id="fs-nosleep-toggle">
            <span class="badge text-bg-secondary ms-1" id="fs-nosleep">-</span>
          </div>
        </div>
      </div>

      <div class="card-body">
        <div class="d-flex flex-wrap gap-2 mb-3 align-items-center">
          <button class="btn btn-dark btn-sm" id="fs-open">Conectar sala</button>
          <button class="btn btn-dark btn-sm" id="fs-close">Sair</button>
          <div class="form-check form-switch m-0">
            <input class="form-check-input" type="checkbox" role="switch" id="fs-autoconnect">
            <label class="form-check-label small" for="fs-autoconnect">auto</label>
          </div>
          <button class="btn btn-dark btn-sm" id="fs-force">Forcar envio</button>
        </div>

        <div class="row g-2 align-items-center mb-3">
          <div class="col-12 col-lg-4">
            <div class="input-group input-group-sm">
              <span class="input-group-text bg-dark text-light border-secondary">Sala</span>
              <input class="form-control" id="fs-room" placeholder="ex.: PET998DR">
            </div>
          </div>
          <div class="col-12 col-lg-3">
            <div class="input-group input-group-sm">
              <span class="input-group-text bg-dark text-light border-secondary">Senha</span>
              <input class="form-control" id="fs-pass" type="password" placeholder="opcional">
            </div>
          </div>
          <div class="col-12 col-lg-3">
            <div class="input-group input-group-sm">
              <span class="input-group-text bg-dark text-light border-secondary">Nome</span>
              <input class="form-control" id="fs-username" placeholder="apelido">
            </div>
          </div>
          <div class="col-12 col-lg-2">
            <select class="form-select form-select-sm bg-dark text-light border-secondary" id="fs-signal" title="Transporte Flowgate">
              <option value="firebase">Firebase</option>
              <option value="peerjs">PeerJS</option>
            </select>
          </div>
        </div>

        <div class="log small mb-2 d-none" id="fs-log"></div>
        <div class="border rounded p-2 mb-1 small" id="fs-peers" style="max-height:160px; overflow:auto;"></div>
      </div>
    `;
    shadow.appendChild(wrap);

    const header = wrap.querySelector('.card-header');
    let drag=false,sx=0,sy=0,ox=0,oy=0;
    header.addEventListener('mousedown', (e)=>{
      drag=true; sx=e.clientX; sy=e.clientY;
      const r = root.getBoundingClientRect(); ox=r.left; oy=r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e)=>{
      if(!drag) return;
      const nx = ox + (e.clientX - sx);
      const ny = oy + (e.clientY - sy);
      root.style.left = nx + 'px';
      root.style.top  = ny + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', ()=> drag=false);

    const el = (id)=> wrap.querySelector(id);
    const LOG_VIS_KEY = 'fs2a-log-visible';
    const logBtn = el('#fs-toggle-log');
    const logEl = el('#fs-log');
    const setLogVisible = (visible)=>{
      if (!logEl || !logBtn) return;
      logEl.classList.toggle('d-none', !visible);
      logBtn.classList.toggle('btn-outline-secondary', !visible);
      logBtn.classList.toggle('btn-success', visible);
      logBtn.textContent = visible ? 'Log aberto' : 'Log';
      try { localStorage.setItem(LOG_VIS_KEY, visible ? '1' : '0'); } catch(_){}
    };
    let logVisible = false;
    try { logVisible = localStorage.getItem(LOG_VIS_KEY) === '1'; } catch(_){}
    setLogVisible(logVisible);
    if (logBtn) {
      logBtn.addEventListener('click', ()=>{
        logVisible = !logVisible;
        setLogVisible(logVisible);
      });
    }

    let lastLogMsg = '';
    let lastLogNode = null;
    let lastLogCount = 1;
    const api = {
      setStatus: (s)=> { const n = el('#fs-status'); if(n) n.textContent = s; },
      log: (m)=>{
        const logEl = el('#fs-log');
        if(!logEl) return;
        const t = new Date().toLocaleTimeString();
        const msg = String(m || '');
        if (msg === lastLogMsg && lastLogNode) {
          lastLogCount += 1;
          const suffix = ` (${lastLogCount}x)`;
          const baseText = lastLogNode.dataset.base || lastLogNode.textContent || '';
          lastLogNode.textContent = `${baseText}${suffix}`;
        } else {
          lastLogMsg = msg;
          lastLogCount = 1;
          const div = document.createElement('div');
          div.dataset.base = `[${t}] ${msg}`;
          div.textContent = div.dataset.base;
          lastLogNode = div;
          logEl.appendChild(div);
          while (logEl.childNodes.length > 220) logEl.removeChild(logEl.firstChild);
        }
        logEl.scrollTop = logEl.scrollHeight;
      },
      setNoSleepStatus: (txt)=> { const n = el('#fs-nosleep'); if(n) n.textContent = txt; },
      renderPeers: ()=>{
        const box = el('#fs-peers');
        if (!box) return;
        const rows = [];
        peers.forEach((info, pid)=>{
          const online = info?.online;
          const name = (info?.name || 'peer').trim();
          const ts = info?.lastSeen ? new Date(info.lastSeen).toLocaleTimeString() : '-';
          rows.push(`<div class="d-flex justify-content-between align-items-center">
            <span>${name} <span class="text-muted">(${String(pid).slice(0,8)})</span></span>
            <span class="badge ${online ? 'text-bg-success' : 'text-bg-secondary'}">${online ? 'online' : 'offline'} ${ts !== '-' ? ts : ''}</span>
          </div>`);
        });
        box.innerHTML = rows.length ? rows.join('') : '<div class="text-muted">sem peers</div>';
      },
      syncSettings: (cfg)=> {
        const data = cfg || S;
        el('#fs-room').value = data.trRoom || '';
        el('#fs-pass').value = data.trPass || '';
        el('#fs-username').value = data.username || '';
        el('#fs-signal').value = sanitizeSignalingMode(data.signalingMode) || SIGNALING_DEFAULT;
        el('#fs-autoconnect').checked = !!data.autoConnect;
        el('#fs-nosleep-toggle').checked = !!data.noSleep;
      }
    };

    el('#fs-nosleep-toggle').checked = !!S.noSleep;
    el('#fs-room').value = S.trRoom;
    el('#fs-pass').value = S.trPass;
    el('#fs-username').value = S.username;
    el('#fs-signal').value = sanitizeSignalingMode(S.signalingMode) || SIGNALING_DEFAULT;
    el('#fs-autoconnect').checked = !!S.autoConnect;

    el('#fs-open').addEventListener('click', connectFlowgate);
    el('#fs-close').addEventListener('click', disconnectFlowgate);
    el('#fs-force').addEventListener('click', ()=>{
      try {
        const snap = snapshot();
        lastSnap = snap;
        broadcastScore(snap, 'force');
        uiApi?.log?.('Snapshot enviado manualmente.');
      } catch(e){
        uiApi?.log?.('Falha ao coletar snapshot: '+(e?.message||e));
      }
    });

    el('#fs-nosleep-toggle').addEventListener('change', (e)=>{
      S.noSleep = !!e.target.checked; save();
      syncAntiSuspend();
    });
    el('#fs-room').addEventListener('change', (e)=>{
      S.trRoom = e.target.value.trim() || DEFAULT_ROOM;
      e.target.value = S.trRoom;
      save();
    });
    el('#fs-pass').addEventListener('change', (e)=>{ S.trPass = e.target.value; save(); });
    el('#fs-username').addEventListener('change', (e)=>{
      S.username = e.target.value.trim(); save();
      startPresenceLoop(S.username);
    });
    el('#fs-signal').addEventListener('change', (e)=>{
      S.signalingMode = sanitizeSignalingMode(e.target.value) || SIGNALING_DEFAULT;
      signalingMode = S.signalingMode;
      save();
    });
    el('#fs-autoconnect').addEventListener('change', (e)=>{ S.autoConnect = !!e.target.checked; save(); });

    return api;
  }

  /**********************
   *        BOOT        *
   **********************/
  function init(){
    uiApi = buildUI();
    uiApi.log('UI Bootstrap carregada.');

    initConsentBridge();
    initSearchBridge();
    startObservers();
    syncAntiSuspend();
    ensureLiveFilter();

    if (S.autoConnect) {
      connectFlowgate().catch(()=>{});
    }

    setTimeout(scheduleCheck, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  document.addEventListener('visibilitychange', ()=>{
    if (!document.hidden && S.noSleep) ensureWakeLock();
  });

})();
