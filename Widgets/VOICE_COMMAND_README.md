# Voice Command Module v1.0

## Descrição

O módulo Voice Command fornece reconhecimento de voz em tempo real para executar comandos de controle do collar. Utiliza a Web Speech API para transcrever fala e mapear palavras-acionadoras para ações no sistema.

## Características

### 1. Monitor de Transcrição
- Exibe texto transcrito em tempo real
- Mostra confiança da transcrição (porcentagem)
- Diferencia entre transcrição interim (em progresso) e final
- Atualização contínua enquanto o usuário fala

### 2. Seletor de Idioma
- Suporte para 10 idiomas:
  - Português (Brasil) - padrão
  - Português (Portugal)
  - English (US / UK)
  - Español
  - Français
  - Deutsch
  - Italiano
  - 日本語
  - 中文 (Simplificado)

### 3. Palavras-Acionadoras
- Interface de texto para definir palavras-chave
- Uma palavra por linha
- Persistência em localStorage
- Visualização automática de comandos mapeados

### 4. Mapeamento de Comandos
Palavras-acionadoras mapeadas automaticamente para ações:

| Palavra | Ação | Ícone |
|---------|------|-------|
| vibra, vibr | VIBRATION mode | 📳 |
| choca, choque | SHOCK mode | ⚡ |
| luz, light, led | LIGHT mode | 💡 |
| beep, som, sound | BEEP mode | 🔊 |
| paro, stop, para | STOP/HOLDOFF | ⏹️ |
| aumenta, plus, mais | Aumentar nível | ⬆️ |
| diminui, minus, menos | Diminuir nível | ⬇️ |

### 5. Modo Contínuo
- Checkbox para reativar escuta automaticamente após comando
- Permite execução de múltiplos comandos sem pausas
- Comportamento útil para sessões prolongadas

### 6. Controles Adicionais
- **Sensibilidade**: Ajusta precisão do reconhecimento (0-100%)
- **Timeout**: Tempo máximo de escuta em segundos (2-30s)
- **Histórico**: Log de eventos com timestamps

## Integração com Sistema

### Fluxo de Funcionamento

1. **Inicialização**: Módulo carrega ao clicar em botão Voice Toggle
2. **Escuta**: Usuário clica em "Escutar" ou botão listening
3. **Reconhecimento**: Web Speech API transcreve fala
4. **Processamento**: Texto comparado com palavras-acionadoras
5. **Execução**: Comando disparado via `window.triggerCommand()`
6. **Sincronização**: Estado propagado via Flowgate se em modo touroble contínuo

### Integração com maincontrol.html

O módulo está totalmente integrado ao maincontrol.html:

- **Botão**: Localizado na barra de módulos (ícone de microfone)
- **Slot**: `#voiceCommandMount` para carregamento dinâmico
- **Estado**: Persistência via localStorage e snapshots do controle
- **Sincronização**: Broadcast de estado entre peers via Flowgate

### Função de Comando

```javascript
window.triggerCommand = function(params) {
  // params: { mode, intensity } ou { action }
  // Integrado ao sistema de comando principal
}
```

## Uso

### Inicialização Básica

1. Abra o webapp CollarController
2. Clique no botão de microfone (Voice Toggle) na barra de módulos
3. Configure as palavras-acionadoras (ex: "vibra", "choca", "paro")
4. Clique em "Escutar" para iniciar reconhecimento
5. Fale um comando (ex: "vibra") para executar

### Configuração Avançada

#### Adicionar Palavra-Acionadora Personalizada

```
seletor_customizado   # Novo seletor
action_custom         # Nova ação
```

#### Ajustar Sensibilidade

Use o slider "Sensibilidade" (padrão: 50%):
- Menor: Menos falsos positivos, mas pode perder comandos reais
- Maior: Detecta mais, mas mais falsos positivos

#### Modo Contínuo

Mantenha "Contínuo" marcado para:
- Reconhecimento automático após cada comando
- Múltiplos comandos sem reiniciar
- Ideal para sessões de controle prolongadas

## Suporte para Navegador

A Web Speech API é suportada em:
- ✅ Chrome/Chromium (melhor suporte)
- ✅ Edge
- ⚠️ Firefox (suporte parcial)
- ✅ Safari (versões recentes)

Navegadores não suportados mostrarão mensagem de erro.

## Troubleshooting

### "Nenhuma fala detectada"
- Verifique volume do microfone
- Tente falar mais alto
- Aumente o timeout

### Palavras não são reconhecidas
- Verifique soletração das palavras-acionadoras
- Teste com palavras mais longas
- Ajuste sensibilidade para cima

### Microfone não funciona
- Conceda permissão de microfone ao navegador
- Verifique se outro aplicativo está usando o microfone
- Tente atualizar o navegador

### Reconhecimento muito lento
- Reduza sensibilidade
- Diminua timeout
- Desative modo contínuo temporariamente

## API e Extensões

### Estrutura de Dados

```javascript
// Log entry
{
  message: string,
  type: 'info' | 'success' | 'warning',
  time: string (HH:MM:SS)
}

// Trigger word
{
  word: string,
  command: {
    mode?: 'SHOCK' | 'VIBRATION' | 'LIGHT' | 'BEEP',
    intensity?: number (0-100),
    action?: 'stop' | 'increase_level' | 'decrease_level'
  }
}
```

### Eventos Personalizados

O módulo dispara eventos que podem ser capturados:

```javascript
// Quando escuta inicia
window.addEventListener('voice:listening-start', (e) => {
  console.log('Escuta iniciada');
});

// Quando comando é detectado
window.addEventListener('voice:command-executed', (e) => {
  console.log('Comando:', e.detail);
});
```

## Salvamento e Persistência

- **Palavras-acionadoras**: Persistidas em `localStorage` (`voice_command_triggers_v1`)
- **Estado do módulo**: Integrado ao sistema de estado do maincontrol
- **Histórico**: Mantido em memória durante a sessão (máx. 50 entradas)

## Performance

- Leve carregamento: ~40KB
- Uso de CPU: Mínimo (apenas durante reconhecimento)
- Uso de Memória: ~5-10MB durante uso ativo
- Compatível com baixa largura de banda

## Licença e Créditos

Desenvolvido como part escrito do CollarController WebApp v4.0
Utiliza Web Speech API (especificação W3C)

## Versões Futuras

Melhorias planejadas:
- [ ] Suporte para comandos compostos ("vibra forte")
- [ ] Macros customizados para sequências de ação
- [ ] Integração com síntese de fala para feedback auditivo
- [ ] Machine learning para reconhecimento de padrões pessoais
- [ ] Suporte para offline (processamento local)

---

**Última atualização**: 2026-03-01
**Versão**: 1.0
