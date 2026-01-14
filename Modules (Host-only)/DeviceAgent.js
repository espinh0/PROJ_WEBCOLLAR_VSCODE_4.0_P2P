<div class="host-only">
<script>
(function(){
  if (window.__EXECUTOR_V2B_ACTIVE__) return;
  window.__EXECUTOR_V2B_ACTIVE__ = true;

  // ===== EXECUTOR LOG SYSTEM =====
  var executorLogs = [];
  var MAX_LOGS = 1000;
  
  function getTimeStr(){
    var t = new Date();
    var hh = String(t.getHours()).padStart(2,'0');
    var mm = String(t.getMinutes()).padStart(2,'0');
    var ss = String(t.getSeconds()).padStart(2,'0');
    var ms = String(t.getMilliseconds()).padStart(3,'0');
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  function logLine(txt){
    console.log(`[${getTimeStr()}] ${txt}`);
    var target = document.getElementById('serial-log');
    if (target){
      var div = document.createElement('div');
      div.textContent = `[${getTimeStr()}] ${txt}`;
      target.appendChild(div);
      target.scrollTop = target.scrollHeight;
    }
  }

  function executorLog(action, cmd, origin, details){
    var entry = {
      ts: Date.now(),
      tsStr: getTimeStr(),
      action: action,
      cmd: cmd,
      origin: origin || 'unknown',
      details: details || {}
    };
    executorLogs.push(entry);
    if (executorLogs.length > MAX_LOGS) executorLogs.shift();
    
    // Atualizar painel visual
    updateExecutorLogPanel();
  }

  function updateExecutorLogPanel(){
    var panel = document.getElementById('executor-flow-log');
    if (!panel) return;
    
    // Manter apenas os últimos 30 logs
    var recentLogs = executorLogs.slice(-30);
    var html = '';
    
    for (var i = 0; i < recentLogs.length; i++){
      var log = recentLogs[i];
      var badgeClass = 'bg-secondary';
      var icon = '●';
      
      if (log.action === 'received'){
        badgeClass = 'bg-info';
        icon = '↓';
      } else if (log.action === 'sent'){
        badgeClass = 'bg-success';
        icon = '↑';
      } else if (log.action === 'error'){
        badgeClass = 'bg-danger';
        icon = '⚠';
      }
      
      var originBg = getOriginBadgeClass(log.origin);
      
      html += `<div class="executor-log-entry mb-2 p-2 border-start border-3" style="border-color: var(--bs-${badgeClass.replace('bg-', '')});">
        <div class="d-flex align-items-center gap-2 mb-1">
          <span class="badge ${badgeClass}">${icon} ${log.action.toUpperCase()}</span>
          <span class="badge ${originBg}" title="Origem">${log.origin}</span>
          <small class="text-muted">${log.tsStr}</small>
        </div>
        <code class="text-break" style="font-size: 0.85em;">${escapeHtml(log.cmd)}</code>`;
      
      if (log.details && Object.keys(log.details).length > 0){
        html += `<div class="small text-muted mt-1">Details: ${escapeHtml(JSON.stringify(log.details))}</div>`;
      }
      
      html += `</div>`;
    }
    
    panel.innerHTML = html || '<div class="text-muted text-center py-4"><small>Aguardando eventos...</small></div>';
    panel.scrollTop = panel.scrollHeight;
  }

  function getOriginBadgeClass(origin){
    if (origin.includes('chat')) return 'bg-warning text-dark';
    if (origin.includes('trystero') || origin.includes('flowgate')) return 'bg-primary';
    if (origin.includes('holdSync')) return 'bg-purple';
    if (origin.includes('serial')) return 'bg-info';
    if (origin.includes('event')) return 'bg-secondary';
    return 'bg-dark';
  }

  function escapeHtml(text){
    var map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, function(m) { return map[m]; });
  }

  window.executorLog = executorLog;
  window.executorLogs = executorLogs;
  window.getExecutorLogs = function(){ return executorLogs; };

  function pickSerialAdapter(){
    try { if (window.SerialBridge && typeof window.SerialBridge.send === 'function') return {name:'SerialBridge', send: window.SerialBridge.send.bind(window.SerialBridge)}; } catch(_){}
    return {name:'SerialBridge', send: function(){ throw new Error('SerialBridge.send indisponivel'); }};
  }
  var SERIAL = pickSerialAdapter();
  function getSerialAdapter(){
    return pickSerialAdapter();
  }

  var processed = new Set();
  var MAX = 500;

  function mark(id){
    processed.add(id);
    if (processed.size > MAX){
      var drop = Math.floor(MAX/5), i=0;
      for (var v of processed){ processed.delete(v); if (++i>=drop) break; }
    }
  }

  function extractText(payload){
    if (!payload) return '';
    if (typeof payload === 'string') return payload;

    if (typeof payload.text === 'string') return payload.text;
    if (payload.raw && typeof payload.raw.text === 'string') return payload.raw.text;

    if (payload.raw && typeof payload.raw.msg === 'string') return payload.raw.msg;
    if (payload.raw && typeof payload.raw.command === 'string') return payload.raw.command;

    if (typeof payload.msg === 'string') return payload.msg;
    if (typeof payload.command === 'string') return payload.command;

    return '';
  }

  function extractOrigin(msg){
    var origin = msg.origin || msg.peerId || 'unknown';
    if (msg.via) origin += ' (' + msg.via + ')';
    return origin;
  }

  function normalizeChatMessage(input){
    var msg = (input && input.detail) ? input.detail : input;
    if (!msg) return null;
    if (msg.type && msg.data) {
      if (msg.type !== 'chat') return null;
      msg = msg.data;
    }
    return msg;
  }

  function buildFallbackId(msg, text, origin){
    var ts = msg.ts || msg.timestamp || '';
    var base = `${origin}|${ts}|${text}`;
    return base && base !== '||' ? base : `noid:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  }

  function onChatMessage(e){
    var msg = normalizeChatMessage(e);
    if (!msg) return;
    var text = extractText(msg).trim();
    if (!text) return;

    var origin = extractOrigin(msg);
    var id  = String(msg.id || msg.key || '');
    if (!id) id = buildFallbackId(msg, text, origin);
    if (processed.has(id)) return;

    executorLog('received', text, origin, {peerId: msg.peerId, username: msg.username});

    var SERIAL = getSerialAdapter();
    try {
      SERIAL.send(text);
      logLine(`ÔåÆ chat ÔûÂ collar (${SERIAL.name}): ${text}`);
      executorLog('sent', text, SERIAL.name, {serialAdapter: SERIAL.name});
    } catch(err){
      logLine(`ÔÜá´©Å falha ao enviar via ${SERIAL.name}: ${err && err.message || err}`);
      executorLog('error', text, SERIAL.name, {error: String(err && err.message || err)});
      return;
    }
    mark(id);
  }

  window.addEventListener('chat:message', onChatMessage);
  window.addEventListener('cmd:message', onChatMessage);
  window.addEventListener('flowgate:message', onChatMessage);

  logLine(`EXECUTOR iniciado ÔÇö aguardando eventos "chat:message"; adaptador: ${SERIAL.name}.`);
  executorLog('init', 'EXECUTOR_START', 'executor', {adapter: SERIAL.name});

  window.addEventListener('beforeunload', function(){
    try { window.removeEventListener('chat:message', onChatMessage); } catch(_){}
  });
})();
</script>
</div>
