# Voice Command - Guia Prático de Uso

## 🎤 Primeiros Passos

### 1️⃣ Iniciar o Módulo

```
1. Abra o CollarController WebApp
2. Localize a barra de módulos no topo
3. Clique no botão de microfone (🎤 ícone roxo)
```

**Resultado esperado**: O módulo Voice Command aparece abaixo da interface principal

### 2️⃣ Configurar Palavras-Acionadoras

No campo "Palavras-Acionadoras", adicione:
```
vibra
choca
luz
beep
paro
aumenta
diminui
```

**Dica**: Uma palavra por linha. O módulo salva automaticamente!

### 3️⃣ Começar a Usar

```
1. Clique no botão "Escutar" (verde)
2. Fale uma palavra (ex: "vibra")
3. Veja o resultado em tempo real
```

---

## 📝 Exemplos de Comandos

### Exemplo 1: Comando Simples (SHOCK)

```
🎙️ Você fala: "choca"
📊 Transcrição: "choca" (confiança: 92%)
⚡ Ação executada: SHOCK mode com intensidade atual
✅ Log: "Comando detectado: 'choca'"
```

### Exemplo 2: Alteração de Intensidade

```
Sequência:
1️⃣ "aumenta" → Intensidade 0% → 10%
2️⃣ "aumenta" → Intensidade 10% → 20%
3️⃣ "diminui" → Intensidade 20% → 10%
```

### Exemplo 3: Alternar Modos

```
1️⃣ "vibra"   → Muda para VIBRATION
2️⃣ "choca"   → Muda para SHOCK
3️⃣ "luz"     → Muda para LIGHT
4️⃣ "beep"    → Muda para BEEP
```

### Exemplo 4: Parar Execução

```
Em execução contínua:
"paro" → HOLDOFF (para tudo)
```

---

## 🌍 Usando Diferentes Idiomas

### Português (Brasil) - Padrão
```
Palavras: vibra, choca, luz, beep, paro, aumenta, diminui
Reconhecimento: Altamente preciso
```

### English (US)
```
1. Altere língua para "English (US)"
2. Use palavras em inglês:
   - "vibrate" ou "vibration" → VIBRATION
   - "shock" ou "electric" → SHOCK
   - "light" ou "led" → LIGHT
   - "beep" ou "sound" → BEEP
   - "stop" ou "halt" → STOP
```

### Español
```
- "vibra" o "vibración" → VIBRATION
- "choque" → SHOCK
- "luz" → LIGHT
- "pitido" → BEEP
- "para" o "alto" → STOP
```

---

## 🎯 Cenários de Uso

### Cenário 1: Sessão Longa com Modo Contínuo

```
✅ Ativar: "Modo" com checkbox "Contínuo" marcado

Sequência:
🎙️ "vibra" →️ [espera]→ 🎙️ "aumenta" → [espera] → 🎙️ "paro"
│             │               │                │
└─ Automático │               └─ Automático    └─ Automático
   reconhecimento após cada           reconhecimento
```

### Cenário 2: Ajuste Preciso de Intensidade

```
📊 Intensidade atual: 30%

1. "aumenta" → 40%
2. "aumenta" → 50%
3. "aumenta" → 60%
4. "diminui" → 50%
⇒ Ajuste fino alcançado!
```

### Cenário 3: Alternância Rápida de Modos

```
Sem parar entre comandos:

"choca" → "aumenta" → "paro" → "vibra" → "aumenta"
└─────────────────────────────────────────────────┘
        Este é um padrão de teste rápido
```

---

## ⚙️ Configurações Recomendadas

### Para Ambiente Silencioso
```
Idioma: Português (Brasil)
Sensibilidade: 70%
Timeout: 5 segundos
Modo Contínuo: SIM
```

### Para Ambiente Barulhento
```
Idioma: Português (Brasil)
Sensibilidade: 30%
Timeout: 10 segundos
Modo Contínuo: NÃO (usar click manual)
```

### Para Velocidade Máxima
```
Idioma: Português (Brasil)
Sensibilidade: 80%
Timeout: 2 segundos
Modo Contínuo: SIM
```

### Para Precisão Máxima
```
Idioma: Português (Brasil)
Sensibilidade: 40%
Timeout: 15 segundos
Modo Contínuo: NÃO
```

---

## 🆘 Troubleshooting

### ❌ "Nenhuma fala detectada"

**Causas possíveis:**
```
1. Microfone desligado/mudo
2. Falou muito baixo
3. Timeout muito curto
```

**Soluções:**
```
1. ✅ Verifique volume do microfone
2. ✅ Fale mais alto e claro
3. ✅ Aumente timeout para 10+ segundos
```

### ❌ Palavra não é reconhecida

**Causas possíveis:**
```
1. Soletração incorreta na palavra-acionadora
2. Sotaque não reconhecido bem
3. Sensibilidade muito baixa
```

**Soluções:**
```
1. ✅ Verifique exatamente como escreveu
2. ✅ Teste pronunciação diferente
3. ✅ Aumente sensibilidade (70%+)
```

### ❌ Reconhecimento muito lento

**Causas possíveis:**
```
1. Navegador sobrecarregado
2. Conexão lenta
3. Timeout muito longo
```

**Soluções:**
```
1. ✅ Feche outras abas
2. ✅ Verifique conexão de internet
3. ✅ Reduza timeout para 2-3 segundos
```

### ❌ Microfone não funciona

**Causas possíveis:**
```
1. Sem permissão para navegador
2. Outro app usando microfone
3. Hardware desconectado
```

**Soluções:**
```
1. ✅ Conceda permissão no navegador:
   - Chrome: Endereço → 🔒 → Permissões → Microfone
2. ✅ Feche aplicativos usando microfone
3. ✅ Verifique se microfone está conectado/ligado
```

---

## 💡 Dicas Pro

### Dica 1: Palavras Únicas
```
❌ Evite: "vibra" e "vibração" juntas
✅ Use: Uma apenas (economiza processamento)
```

### Dica 2: Pronunciação Clara
```
❌ Não funciona bem: Sussurrado ou muito rápido
✅ Funciona melhor: Pronunciação normal e clara
```

### Dica 3: Pausa Entre Comandos
```
❌ Não ideal: "vibraaumentaaumentaparo" (tudo junto)
✅ Ideal: "vibra" [pausa] "aumenta" [pausa] "aumenta" [pausa] "paro"
```

### Dica 4: Modo Contínuo em Seções
```
✅ Use continuado por 30-60 segundos
✅ Faça pausa
✅ Reinicie quando necessário
└─ Evita fadiga do sistema
```

### Dica 5: Teste com Palavras Diferentes
```
Se "choca" não funciona bem:
Tente: "choque", "shock", "eletrico"
└─ O reconhecimento é flexível!
```

---

## 📊 Monitor de Transcrição

### O que cada item significa

```
Texto Final (branco): Já confirmado pelo sistema
Texto Interim (cinza): Sendo processado, pode mudar
─────────────────
Confiança: 92%     ← Quanto o sistema tem certeza
```

### Leitura do Histórico

```
✓ (verde) = Comando executado com sucesso
⚠️ (laranja) = Aviso ou comando incompleto
✖️ (vermelho) = Erro ao executar
ℹ️ (azul) = Informação
```

---

## 🔄 Workflow Recomendado

### Para Iniciantes
```
1. Carregar módulo
2. Adicionar 3 palavras ("vibra", "choca", "paro")
3. Desativar "Contínuo"
4. Pressionar "Escutar"
5. Falar 1 palavra por vez
6. Esperar resultado
7. Repetir
```

### Para Usuários Experientes
```
1. Carregar módulo
2. Adicionar 7-10 palavras personalizadas
3. Ativar "Contínuo"
4. Reduzir sensibilidade se houver ruído
5. Executare sequência de comandos
6. Usar "paro" para parar
```

---

## 📈 Performance Esperada

| Operação | Tempo | Notas |
|----------|-------|-------|
| Carregar módulo | <1s | Fast |
| Iniciar escuta | <200ms | Instantâneo |
| Reconhecer palavra | 0.5-2s | Depende comprimento |
| Executar comando | ~100ms | Quasi-instant |
| Salvar palavras | <100ms | Background |

---

## 🎮 Jogos/Atividades com Voice

### Atividade 1: Teste de Reação
```
1. Ativar "Contínuo"
2. Dar comando: "vibra"
3. Contar quanto tempo para reconhecer
4. Comparar com clicks manuais
```

### Atividade 2: Sequência Memorizada
```
1. Memorize: vibra, aumenta, aumenta, paro
2. Fale-os em sequência
3. Cronômetro quanto tempo leva
4. Tente bater seu recorde
```

### Atividade 3: Precisão
```
1. Defina sensibilidade em 50%
2. Fale mesma palavra 10 vezes
3. Conte quantas vezes funcionou
4. Objetivo: 10/10 corretas
```

---

## 🎓 Recursos Adicionais

### Melhore seu Reconhecimento
```
1. Pratique pronunciação clara
2. Teste em ambientes diferentes
3. Ajuste idioma se necessário
4. Tente diferentes microfones
```

### Aproveite o Módulo
```
1. Combine com Modo Contínuo
2. Use em sessões longas
3. Experimente diferentes palavras
4. Integre com outros módulos
```

---

## 📞 Suporte Rápido

### Erro Comun | Solução
```
"Não reconheceu"     → Fale mais alto/claro
"Demora muito"       → Reduza timeout
"Falsos positivos"   → Reduza sensibilidade
"Micro não funciona" → Pesquisa atalhos do SO
```

---

**Última Atualização**: 2026-03-01
**Versão**: 1.0
**Status**: Pronto para Uso! 🚀
