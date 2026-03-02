# 📋 Remaining Issues - P1 & P2 Improvements

## 📊 Status Global

| Severidade | Total | Implementado | Pendente | Prio |
|-----------|-------|--------------|----------|------|
| 🔴 **P0** | 2 | ✅ 2 | — | CRITICAL |
| 🟠 **P1** | 2 | — | ⏳ 2 | HIGH |
| 🟡 **P2** | 6 | — | ⏳ 6 | LOW |

---

## 🟠 P1: Issues de Alta Prioridade

### P1.1: Speech API Config Fallback para Silêncio

**Severidade**: 🟠 ALTA  
**Localização**: `initSpeechRecognition()` → `const recognition = new webkitSpeechRecognition()`  
**Impacto**: Voice recognition pode "travar" em ambientes com muito ruído  

#### Problema

```javascript
// ATUAL (sem tratamento):
const recognition = new webkitSpeechRecognition();
recognition.continuous = true;
recognition.interimResults = true;
// ❌ Sem fallback se browser silenciar automaticamente
```

Alguns browsers silenciam speech recognition se:
- Nenhuma palavra-chave detectada por 30+ segundos
- Ruído de fundo muito alto (SNR baixo)
- Permissão de áudio instável

#### Solução Proposta

```javascript
const recognition = new webkitSpeechRecognition();
recognition.continuous = true;
recognition.interimResults = true;

let silenceTimerP1 = null;
const SILENCE_DETECTION_THRESHOLD_P1 = 30000; // 30s

recognition.onresult = (event) => {
  // ✨ Resetar timer se transcription chegou
  clearTimeout(silenceTimerP1);
  
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const transcript = event.results[i][0].transcript;
    if (transcript.trim()) {
      // Restart timer
      silenceTimerP1 = setTimeout(() => {
        console.warn('[VOICE] Silêncio prolongado detectado, reiniciando...');
        stopSpeechRecognition();
        setTimeout(() => initSpeechRecognition(), 1000);
      }, SILENCE_DETECTION_THRESHOLD_P1);
      break;
    }
  }
};

// Reiniciar a cada 30s se nenhuma palavra
function schedulePeriodicRestartP1() {
  if (recognitionActive && !silenceTimerP1) {
    silenceTimerP1 = setTimeout(() => {
      console.log('[VOICE] Restart periódico (P1.1)');
      stopSpeechRecognition();
      setTimeout(() => initSpeechRecognition(), 500);
    }, 30000);
  }
}
```

**Esforço Estimado**: 15-20 min  
**Complexidade**: Média  
**Risk**: Baixo (apenas restart automático)

---

### P1.2: Audio Permission Race Condition

**Severidade**: 🟠 ALTA  
**Localização**: `initSoundDetector()` → `audioContext.resume()`  
**Impacto**: Closed Captions pode não iniciar em primeiro clique

#### Problema

```javascript
// ATUAL (sem sincronização):
soundDetectionActive = true;
audioContext.resume();  // ← Pode ser async
analyserNode = audioContext.createAnalyser();
// ❌ Se audioContext.resume() não completou, analyser está em estado inconsistente
```

Race condition: `audioContext.resume()` retorna uma Promise, mas código não awaita. Resulta em:
- CC não ativa no primeiro clique
- Erro "AudioContext not running" no console
- Precisa clicar 2-3 vezes para funcionar

#### Solução Proposta

```javascript
async function initSoundDetectorAsync() {
  soundDetectionActive = true;
  
  // ✨ Aguardar permissão explicitamente
  try {
    const permission = await navigator.permissions?.query({ name: 'microphone' });
    if (permission && permission.state === 'denied') {
      throw new Error('Microphone permission denied');
    }
    
    // Aguardar contexto estar pronto
    if (audioContext.state !== 'running') {
      await audioContext.resume();
    }
    
    // Agora criar analyser com segurança
    if (!analyserNode) {
      const sourceNode = audioContext.createMediaStreamAudioSourceFromAudioWorklet(stream);
      analyserNode = audioContext.createAnalyser();
      sourceNode.connect(analyserNode);
    }
    
    console.log('[VOICE] Sound detector iniciado');
    analyzeSoundFrame();
    
  } catch (error) {
    console.error('[VOICE] Erro ao inicializar CC:', error);
    soundDetectionActive = false;
    showNotification('Erro ao ativar Legendas. Verificar permissões.', 'error');
  }
}

// Usar com:
if (soundDetectionCheckbox) {
  soundDetectionCheckbox.addEventListener('change', async (e) => {
    if (e.target.checked) {
      await initSoundDetectorAsync();  // ← Aguardar
    } else {
      stopSoundDetector();
    }
  });
}
```

**Esforço Estimado**: 20-25 min  
**Complexidade**: Média-Alta  
**Risk**: Médio (refatoração de fluxo async)

---

## 🟡 P2: Issues de Baixa Prioridade

### P2.1: No Debounce on Slider Events

**Severidade**: 🟡 BAIXA  
**Localização**: `voice-phrase-commit-delay` input event listener  
**Impacto**: localStorage write a cada pixel arrastado (performance menor, life cycle SSD)  

#### Problema

```javascript
// ATUAL:
document.getElementById('voice-phrase-commit-delay')?.addEventListener('input', () => {
  updatePhraseCommitDelay();  // ← localStorage.setItem a cada event
});
// Ao arrastar slider: 100+ eventos em 1 segundo
// → 100+ localStorage writes
```

#### Solução Proposta

```javascript
let phraseDelayDebounceTimer = null;

document.getElementById('voice-phrase-commit-delay')?.addEventListener('input', () => {
  clearTimeout(phraseDelayDebounceTimer);
  
  // ✨ Atualizar UI imediatamente (responsivo)
  const delay = Number(document.getElementById('voice-phrase-commit-delay').value);
  const badge = document.getElementById('voice-phrase-commit-delay-display');
  if (badge) badge.textContent = `${delay}ms`;
  
  // ✨ Salvar em localStorage apenas após parar de arrastar (300ms)
  phraseDelayDebounceTimer = setTimeout(() => {
    updatePhraseCommitDelay();  // localStorage.setItem aqui
    console.log('[VOICE] Phrase delay debounce save:', delay);
  }, 300);
});
```

**Esforço Estimado**: 5 min  
**Complexidade**: Muito Baixa  
**Risk**: Muito Baixo (apenas timing change)

---

### P2.2: Unable to Stop Sound Detection on Error

**Severidade**: 🟡 BAIXA  
**Localização**: `initSoundDetector()` → error handling  
**Impacto**: Se erro na inicialização, CC continue tentando (loop infinito)  

#### Problema

```javascript
// ATUAL:
if (soundDetectionActive) {
  // ... init code ...
  // ❌ Se erro ocorre, soundDetectionActive = true mas detector não rodando
  // → Usuario desativa checkbox mas loop continua tentando
}
```

#### Solução Proposta

```javascript
function stopSoundDetectorCompletely() {
  soundDetectionActive = false;
  
  // Limpar todos os timers
  if (detectorRafId) {
    if (typeof detectorRafId === 'number' && detectorRafId > 1000000) {
      cancelAnimationFrame(detectorRafId);
    } else {
      clearTimeout(detectorRafId);
    }
    detectorRafId = null;
  }
  
  // Limpar contexto
  if (analyserNode) {
    analyserNode.disconnect();
    analyserNode = null;
  }
  
  audioIdleCount = 0;
  
  // ✨ Deselecionar checkbox se foi erro
  const checkbox = document.getElementById('voice-sound-detection-checkbox');
  if (checkbox && checkbox.checked) {
    checkbox.checked = false;  // Sincronizar UI
  }
}

// Usar em catch:
try {
  // init code
} catch (error) {
  console.error('[VOICE] CC error:', error);
  stopSoundDetectorCompletely();
  showNotification('Erro ao inicializar Legendas', 'error');
}
```

**Esforço Estimado**: 10 min  
**Complexidade**: Baixa  
**Risk**: Muito Baixo (apenas cleanup melhorado)

---

### P2.3: Console Spam on Each Frame

**Severidade**: 🟡 BAIXA  
**Localização**: `analyzeSoundFrame()` → console.log calls  
**Impacto**: DevTools console fica lento se CC ativa por longo tempo (60 msgs/s)  

#### Problema

```javascript
// ATUAL:
function analyzeSoundFrame() {
  // ... análise ...
  console.log('[VOICE] RMS:', soundRmsSmooth); // ← Cada frame de 16ms
  // = 60 logs/segundo
}
```

#### Solução Proposta

```javascript
let lastLogTime = 0;
const LOG_THROTTLE_MS = 1000; // Logar a cada 1s

// Em analyzeSoundFrame:
const now = Date.now();
if (now - lastLogTime > LOG_THROTTLE_MS) {
  console.log('[VOICE] Sound RMS (last 1s avg):', soundRmsSmooth.toFixed(2));
  lastLogTime = now;
}

// Para debug detalhado, usar flag:
if (window.VOICE_COMMAND_DEBUG_FRAMES) {
  console.log('[VOICE DEBUG] Frame:', {
    rms: soundRmsSmooth,
    idle: audioIdleCount,
    frequency: frequencyData[dominantFreqIndex]
  });
}
```

**Esforço Estimado**: 5 min  
**Complexidade**: Muito Baixa  
**Risk**: Muito Baixo (apenas logging change)

---

### P2.4: Trigger Word Partial Match Vulnerability

**Severidade**: 🟡 BAIXA  
**Localização**: `processTranscript()` → trigger matching logic  
**Impacto**: Palavra "sim" pode ativar comando "sim ativa" quando não intencional  

#### Problema

```javascript
// ATUAL:
function findMatchingTrigger(transcriptText) {
  for (const trigger of triggerWords) {
    if (transcriptText.toLowerCase().includes(trigger.word.toLowerCase())) {
      return trigger;  // ❌ Partial match!
    }
  }
  return null;
}

// Exemplo:
// Trigger: "sim"
// Transcript: "Eu acho que sim ativa"
// → Executa comando mesmo que não tenha dito só "sim"
```

#### Solução Proposta

```javascript
function findMatchingTriggerV2(transcriptText, words) {
  const transcriptWords = transcriptText.toLowerCase().split(/\s+/);
  
  for (const trigger of triggerWords) {
    const triggerWords = trigger.word.toLowerCase().split(/\s+/);
    
    // Procurar sequência exata de palavras
    for (let i = 0; i <= transcriptWords.length - triggerWords.length; i++) {
      const slice = transcriptWords.slice(i, i + triggerWords.length);
      if (slice.join(' ') === triggerWords.join(' ')) {
        return trigger;
      }
    }
  }
  return null;
}

// Exemplo melhorado:
// Trigger: ["sim"]
// Transcript: "Eu acho que sim ativa"
// → Encontra "sim" como palavra completa
// ✅ Executa comando
```

**Esforço Estimado**: 15 min  
**Complexidade**: Média  
**Risk**: Baixo (melhora acurácia)

---

### P2.5: Memory Leak in Event Listeners

**Severidade**: 🟡 BAIXA  
**Localização**: `bindElementOnce()` / widget rehydration  
**Impacto**: Se widget reabrir 10x, listeners podem acumular (minor memory leak)  

#### Problema

```javascript
// ATUAL:
function bindUiEventListeners() {
  // Listeners adicionados sem remover anteriores
  commandsList.addEventListener('click', handleRemove);
  // ❌ Se chamado 10x, 10 listeners de click
}

// Se widget rehydrata (abre/fecha):
// open → add listener #1
// close → (listeners não removidos)
// open → add listener #2
// close → (listeners não removidos)
// = 2 listeners now
```

#### Solução Proposta

```javascript
function cleanupUiEventListeners() {
  // Remover listeners antigos
  if (commandsList) {
    // Clone node para remover todos os listeners
    const newList = commandsList.cloneNode(false);
    commandsList.parentNode.replaceChild(newList, commandsList);
    commandsList = newList;
  }
}

function bindUiEventListeners() {
  // Cleanup primeiro
  cleanupUiEventListeners();
  
  // Agora adicionar (novo listener)
  commandsList.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('button[data-action="remove-trigger"]');
    if (removeBtn) {
      const triggerId = removeBtn.getAttribute('data-trigger-id');
      removeTriggerWord(triggerId);
    }
  });
}

// Chamar cleanup ao widget descarregar
window.addEventListener('beforeunload', () => {
  cleanupUiEventListeners();
});
```

**Esforço Estimado**: 10 min  
**Complexidade**: Baixa  
**Risk**: Muito Baixo (apenas cleanup)

---

### P2.6: No Timeout for Long-Running Commands

**Severidade**: 🟡 BAIXA  
**Localização**: `executeCommand()` → callback
**Impacto**: Se comando não completar, UI fica "travada" aguardando resposta  

#### Problema

```javascript
// ATUAL:
async function executeCommand(trigger) {
  commandExecutionInProgress = true;
  
  try {
    // Chamar comando via maincontrol
    await window.triggerCommand(trigger.commandId);
    // ❌ Se triggerCommand não completar, UI travada
  } finally {
    commandExecutionInProgress = false;
  }
}
```

#### Solução Proposta

```javascript
const COMMAND_EXECUTION_TIMEOUT_MS = 5000; // 5s max

async function executeCommandWithTimeout(trigger) {
  commandExecutionInProgress = true;
  
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Command timeout')), COMMAND_EXECUTION_TIMEOUT_MS)
    );
    
    const commandPromise = window.triggerCommand(trigger.commandId);
    
    // ✨ Raça: comando ou timeout
    await Promise.race([commandPromise, timeoutPromise]);
    
    console.log('[VOICE] Command completed:', trigger.word);
    
  } catch (error) {
    console.error('[VOICE] Command failed:', error.message);
    showNotification(`Comando falhou: ${error.message}`, 'error');
  } finally {
    commandExecutionInProgress = false;
  }
}
```

**Esforço Estimado**: 10 min  
**Complexidade**: Média  
**Risk**: Baixo (non-blocking timeout)

---

## 📊 Matriz de Priorização

```
                 Impacto
               ↑
IMPLEMENTAR JÁ |  P1.1  P1.2
               |  P0.1  P0.2
               |
CONSIDERAR    |  P2.4  P2.1
               |  P2.5  P2.6
               |  P2.2  P2.3
               |________________→ Esforço
```

### Recomendação

**Curto Prazo** (Esta semana):
1. ✅ P0.1 + P0.2 (done)
2. 🧪 Testar com TESTING_GUIDE.md
3. 🚀 Deploy P0

**Médio Prazo** (Próxima semana):
1. P1.1 (Speech API fallback) - 15min
2. P1.2 (Audio permission async) - 20min
3. 🧪 Testar P1
4. 🚀 Deploy P1

**Longo Prazo** (Future):
1. P2.x issues (optionais, melhorias)
2. Monitorar em produção
3. Feedback de usuários

---

**Status**: 📋 Documentado  
**Data**: Março 2026  
**Versão**: Analysis v1.0
