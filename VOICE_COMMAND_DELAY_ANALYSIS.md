# Voice Command Module - Análise Detalhada de Delays

## 📋 Resumo Executivo

O módulo de comando por voz implementa **múltiplas camadas de delay** para equilibrar **responsividade** (execução rápida) com **confiabilidade** (evitar falsos positivos e execução duplicada). Cada delay tem um propósito específico e pode ser ajustado via parâmetros avançados.

---

## 🔴 Principais Fontes de Delay

### 1. **Phrase Commit Delay** (Velocidade de Confirmação)
**Arquivo**: [`voice_command.html`](Widgets/voice_command.html#L1721)  
**Variável**: `phraseCommitDelayMs`  
**Padrão**: `220ms`  
**Range**: 50ms - 1000ms

#### O que faz:
Tempo de espera **após receber um resultado final** da Web Speech API antes de confirmar a frase e processar comandos. Permite que o usuário continue falando ou faça correções antes da execução.

#### Por que existe:
- **Web Speech API** entrega resultados finais em eventos separados
- Se executar imediatamente no primeiro resultado, pode processar frases incompletas
- Aguardar um pouco permite acumular múltiplos resultados finais

#### Fluxo de Execução:
```
[Usuário fala] → Web Speech API → "vibra" (final) 
                                      ↓
                            [Aguarda phraseCommitDelayMs] 
                                      ↓
                            [Busca por mais resultados]
                                      ↓
                            Sem novos resultados? → Processa | Novo resultado? → Reinicia timer
```

#### Impacto:
- **Muito baixo (50ms)**: Responsivo, mas pode executar frases incompletas duplicadas
- **Balanceado (220ms)**: ✅ Recomendado para a maioria dos casos
- **Alto (500ms+)**: Conservador, permite correções, mas sente "lento"

---

### 2. **Sound Detection Delays** (Detecção de Sons Ambiente - CC)

#### 2.1 Responsividade CC
**Variável**: `soundSmoothAlpha`  
**Padrão**: `0.35` (convertido de 50%)  
**Range**: 0.1 - 0.8

**Fórmula**:
```
soundSmoothAlpha = 0.1 + (responsiveness / 100) * 0.7
```

**O que faz**: Controla quanto o valor RMS (volume) anterior influencia o valor atual em uma média móvel exponencial.

```javascript
soundRmsSmooth = (soundRmsSmooth * (1 - alpha)) + (rms * alpha)
```

- **Alpha baixo (0.1)**: Histórico conta mais, transições lentas, suave
- **Alpha alto (0.8)**: Reativo imediato, pode "piscar"

**Impacto de Delay**: ~20-50ms introduzidos pela suavização

---

#### 2.2 Estabilidade CC (Hold Time)
**Variável**: `soundHoldBaseMs`  
**Padrão**: `200ms` (convertido de 50%)  
**Range**: 50ms - 500ms

**Fórmula**:
```
soundHoldBaseMs = 50 + (stability / 100) * 450
```

**O que faz**: Tempo mínimo que a categoria de som deve se manter estável antes de atualizar o monitor.

```javascript
if ((now - soundCandidateSince) >= holdMs) {
  // Atualizar monitor se categoria mudou
}
```

- **Baixo (50ms)**: Detecta mudanças rápido, mas "pisca" entre categorias
- **Alto (500ms)**: Estável, menos flicker, mas demora a atualizar

**Impacto de Delay**: ~50-500ms de latência na atualização visual

---

### 3. **Execution Step Delay** (Espaçamento entre Múltiplos Comandos)
**Arquivo**: [`voice_command.html`](Widgets/voice_command.html#L1757)  
**Constante**: `EXECUTION_STEP_MS = 90ms`  
**Não configurável**

#### O que faz:
Quando múltiplos comandos são detectados na mesma frase, o primeiro executa imediatamente e os subsequentes são espaçados por 90ms.

```javascript
if (position === 0) {
  run();  // Imediato
} else {
  setTimeout(run, position * 90);  // Espaçado
}
```

#### Por que existe:
- Evita sobrecarregar o dispositivo com múltiplos comandos simultâneos
- Deixa a UI processar estado entre comandos
- Implementa fila natural

#### Exemplo:
```
Usuário fala: "vibra aumenta aumenta"

Resultado: 
  T+0ms:    Executa "vibra" (VIBRATION)
  T+90ms:   Executa "aumenta" (aumenta intensidade)
  T+180ms:  Executa "aumenta" (aumenta intensidade)
```

---

### 4. **Non-Continuous Timeout** (Timeout de Escuta Única)
**Arquivo**: [`voice_command.html`](Widgets/voice_command.html#L1121)  
**Constante**: `NON_CONTINUOUS_TIMEOUT_MS = 45000ms (45 segundos)`  
**Não configurável**

#### O que faz:
Quando modo **contínuo está desativado**, a escuta interrompe após 45 segundos de inatividade.

#### Por que existe:
- Web Speech API pode ficar em estado "listening" indefinidamente
- Economiza bateria e processamento
- Força reinicialização para "resetar" amostra

---

### 5. **Continuous Mode Restart Delay** (Reinício Automático na Escuta Contínua)
**Arquivo**: [`voice_command.html`](Widgets/voice_command.html#L1674)  
**Delay**: `250ms`

#### O que faz:
Após um resultado final no modo contínuo, aguarda 250ms antes de reiniciar a escuta.

```javascript
setTimeout(() => {
  if (!recognition || isListening || !shouldKeepListening) return;
  recognition.start();
}, 250);
```

#### Por que existe:
- Evita sobreposição de eventos `onend` e novo `onstart`
- Permite processamento do resultado anterior
- Previne anomalias de estado da Web Speech API

---

### 6. **SOUND_LOG_MIN_INTERVAL_MS** (Throttle de Log de Sons)
**Arquivo**: [`voice_command.html`](Widgets/voice_command.html#L1117)  
**Constante**: `1200ms (1.2 segundos)`  
**Não configurável**

#### O que faz:
Evita spam no histórico quando som é detectado continuamente. Só loga a cada 1.2 segundos.

```javascript
if (descriptor.key !== 'silence' && (now - lastSoundLoggedAt) >= 1200) {
  addLog(`CC detectado: ${descriptor.label}`, 'info');
  lastSoundLoggedAt = now;
}
```

---

## 📊 Tabela de Todos os Delays

| Delay | Local | Tipo | Padrão | Range | Variável | Configurável |
|-------|-------|------|--------|-------|----------|--------------|
| **Phrase Commit** | Processamento de frase | Funcional | 220ms | 50-1000ms | `phraseCommitDelayMs` | ✅ Sim |
| **CC Responsiveness** | Suavização de áudio | Funcional | 0.35 (50%) | 0.1-0.8 | `soundSmoothAlpha` | ✅ Sim |
| **CC Stability** | Hold time de categoria | Funcional | 200ms | 50-500ms | `soundHoldBaseMs` | ✅ Sim |
| **Execution Step** | Espaçamento de comandos | Estrutural | 90ms | Fixo | Hardcoded | ❌ Não |
| **Non-Continuous Timeout** | Timeout de escuta | Estrutural | 45s | Fixo | Hardcoded | ❌ Não |
| **Continuous Restart** | Reinício automático | Estrutural | 250ms | Fixo | Hardcoded | ❌ Não |
| **Sound Log Throttle** | Limite de logging | Estrutural | 1200ms | Fixo | Hardcoded | ❌ Não |

---

## 🎯 Presets Predefinidos

O módulo segue 3 presets que combinam os delays:

### **Responsivo** 🚀
```javascript
{
  responsiveness: 90,     // CC muito reativo (alpha: 0.73)
  stability: 10,          // CC react rápido (hold: ~59ms)
  phraseDelay: 150        // Confirmação rápida
}
```
**Uso**: Quando quer máxima responsividade, ambiente controlado (sem ruído ambiente)

### **Balanceado** ⚖️ (Padrão)
```javascript
{
  responsiveness: 50,     // CC médio (alpha: 0.45)
  stability: 50,          // CC médio (hold: ~275ms)
  phraseDelay: 220        // Confirmação normal
}
```
**Uso**: Recomendado para maioria dos cenários

### **Estável** 🛡️
```javascript
{
  responsiveness: 20,     // CC muito suave (alpha: 0.24)
  stability: 80,          // CC muito estável (hold: ~410ms)
  phraseDelay: 500        // Confirmação conservadora
}
```
**Uso**: Ambiente ruidoso, quer evitar falsos positivos

---

## 🔄 Fluxo Completo com Delays

```
[Usuário inicia escuta]
  ↓
[Web Speech API ativa] → recognition.onstart()
  ↓
[AnalyzerNode conectado ao microfone] → startSoundDetector()
  ↓
[Usuário fala: "vibra"]
  ↓
[Eventos result chegam]
  - interim: "vibra" (t=0ms)
  - interim: "vibra" (t=50ms)
  - final: "vibra" (t=100ms) ← Trigga queueTranscriptProcessing()
  ↓
[Aguarda phraseCommitDelayMs = 220ms]
  +-----------[170ms restantes, processando transcrição em live mode]
  ↓
[Timeout dispara] ← Trigga setTimeout no phraseCommitTimer
  ↓
[Executa processTranscript() com commit=true]
  ↓
[Encontra "vibra" em triggerWords]
  ↓
[Executa executeCommand(trigger)] T+0ms
  ↓
[Envia window.triggerCommand() → maincontrol.html → SerialBridge]
  ↓
[Firmware recebe comando, executa VIBRATION]
```

---

## 🎚️ Guia de Ajuste

### Cenário: Muito lento na resposta
**Sintomas**: Atraso perceptível entre falar e executor

**Solução (em ordem)**:
1. Reduzir `phraseDelay` para 150ms (mais agressivo)
2. Aumentar `responsiveness` para 70-80%
3. Verificar latência da Web Speech API (navegador/internet)

---

### Cenário: Executa comandos duplicados
**Sintomas**: Mesmo comando executado 2x para uma fala

**Causa Possível**:
- `phraseDelay` muito baixo, processando resultados incompletos
- Múltiplos resultados "finais" em sequência rápida

**Solução**:
1. Aumentar `phraseDelay` para 300-500ms
2. Usar preset "Estável"
3. Verificar se o navegador está bugado (reiniciar escuta)

---

### Cenário: Colares não recebem comandos
**Sintomas**: UI mostra detecção, mas nada acontece

**Causa Possível**:
- Serial Connection está desconectada (Host)
- Flowgate não está propagando (Visitor)
- Comando está sendo fila mas não executado

**Solução**:
1. Verificar console do navegador para erros
2. Confirmar `triggerCommand()` é chamado
3. Testar comando manual (botão) para comparar

---

### Cenário: Detecção de som CC não funciona
**Sintomas**: CC desativado, inputs não aparecem, ou sempre mostra "Silêncio"

**Causa Possível**:
- Permissão de microfone não concedida
- AudioContext suspenso ou não inicializado
- Sensibilidade CC muito baixa

**Solução**:
1. Verificar permissão de microfone no navegador
2. Aumentar `voice-cc-sensitivity` slider (> 50%)
3. Verificar console para erro "AudioContext"

---

## 🧪 Testes Recomendados

### Teste 1: Baseline de Latência
```bash
Falar: "vibra"
Medir tempo entre "vibra" e vibração física do colar
Esperado: 300-500ms (incluindo Serial + Firmware)
```

### Teste 2: Múltiplos Comandos
```bash
Falar: "vibra aumenta aumenta diminui"
Verificar ordem e espaçamento no log
Esperado: Executados em sequência, 90ms entre cada
```

### Teste 3: Contínuo vs. Não-Contínuo
```bash
Ativar escuta, falar 2 comandos
Modo contínuo: Sem pausa entre comandos
Modo não-contínuo: Pausa e reinício após primeiro
```

### Teste 4: Robustez em Ruído
```bash
Ligar música de fundo
Tentar comandos
Verificar:
  - Quantas false positives
  - CC detecta corretamente som ambiente
  - Usar preset "Estável" se necessário
```

---

## 📌 Notas Importantes

1. **Delays são aditivos**: Latência final = Network + Web Speech API + `phraseDelay` + Serial + Firmware
2. **Configuração por usuário**: Cada preset pode ser salvo em localStorage
3. **CC é independente de reconhecimento**: Liga/desliga separadamente
4. **Não há fila de comandos**: Se 2 comandos chegarem antes do primeiro ser processado, podem ser perdidos
5. **Sensibilidade CC afeta Hold**: Sensibilidade baixa = hold aumentado automaticamente

---

## 🔗 Referências

- **Arquivo principal**: [voice_command.html](Widgets/voice_command.html)
- **Integração**: [maincontrol.html](maincontrol.html)
- **Documentação de widgets**: [VOICE_COMMAND_README.md](Widgets/VOICE_COMMAND_README.md)
- **Guia prático**: [VOICE_COMMAND_PRACTICAL_GUIDE.md](VOICE_COMMAND_PRACTICAL_GUIDE.md)

---

**Última atualização**: Março 2026  
**Status**: ✅ Completo e Documentado
