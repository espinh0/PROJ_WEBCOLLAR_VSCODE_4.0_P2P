## Bibliotecas Globais Disponíveis

As seguintes bibliotecas já estão carregadas globalmente e podem ser usadas por módulos e widgets (não as carregue novamente):

### JavaScript
- **Ion.Sound** (audio util): https://cdn.jsdelivr.net/gh/IonDen/ion.sound@3.0.7/js/ion.sound.min.js
- **Howler.js** (audio engine): https://cdnjs.cloudflare.com/ajax/libs/howler/2.2.4/howler.min.js
- **Bootstrap JS**: https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js

### CSS
- **Bootstrap CSS**: https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css
- **Font Awesome**: https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css
- **Google Fonts Anton**: https://fonts.googleapis.com/css2?family=Anton&display=swap

Essas bibliotecas são carregadas em `libraries.html` e `index_integration.html`.

# Copilot Instructions for CollarController WebApp

## Architecture Overview
- The system architecture is based on:
  - **Firmware (Arduino)**: Device logic and hardware control, see `Firmware/`.
  - **WebApp**: Launched via `index_integration.html`, composed of modular scripts in `Modules/` and `Modules (Host-only)/`.
  - **Flowgate**: The core peer-to-peer and sync layer, managing all communication between the webapp and firmware, and between Host/Visitor roles.
- **Host** is the only entity allowed to initiate and manage serial connections. All host-exclusive logic must be clearly marked and only run in Host mode.
- **Serial_Connection** exclusively manages serial communication (see `Modules (Host-only)/serialport` and related files). Serial logic must not be duplicated elsewhere.
- **Executor** processes commands from visitors and manages serial actions, running only on Host.
- **Widgets** are feature modules that use Flowgate for sync and state, and should not duplicate module logic.
- **Modules** are core scripts for business logic, communication, and UI, reused by widgets. Do not duplicate module code in widgets.

- **Deterministic Sync:** All state sync is based on host timestamps. Host is the authority; peers render state using host time plus clock offset. Events (e.g., hold/release) must have unique IDs and be replayable after backgrounding.
- **Payload Examples:**
  - `hello: { t:"hello", from:"peer-id", ts:1735689600000 }`
  - `hold: { t:"hold", id:"evt_abc123", startedAt:..., ... }`
- **Commands:** Visitors send commands to Host via Flowgate; Host updates state for all. Only Host can update serial state.
- **Heartbeat:** Periodic signals keep firmware informed of connection status. If no response, firmware should halt execution (see heartbeat logic).
- **Logging:** Serial monitor and logs must show real-time connection status, actions, and errors. Use clear, concise language and visual cues.
 - **UI:** Must be responsive, state-persistent, accessible, and provide clear feedback for user actions.
 - **Styling:** Always prioritize Bootstrap classes for layout and appearance. Only use custom (hardcoded) CSS when it is not possible to achieve the desired result with Bootstrap.
- **Versioning:** Update version numbers and document changes in comments when modifying files.
- **No duplicate scripts:** Scripts must be organized by logical function (UI, comms, business logic). No scripts in `index` files.

- **Global Library Loading:** Modules must not load libraries directly. All libraries must be loaded globally (e.g., in `libraries.html` or main entry points) to avoid duplication and ensure a single instance is used throughout the app.


## Developer Workflows
- **Backups Bak agent-ignore/** must be ignored. Do not reference, restore, or update any code or documentation in this folder.
- **General_Rules.txt is outdated.** For current architecture and conventions, refer to this file and comments in module files.
- **Host-only logic:** All logic that must only run on the Host should be placed in `Modules (Host-only)/`, clearly marked, and guarded by runtime checks to ensure it only executes in Host mode. Host-only features must never be accessible or executed by visitors.
- **Do not reinstall libraries** already present in the workspace.


## Key Files & Directories
- `Firmware/` — Arduino firmware source (device logic)
- `index_integration.html` — Main webapp entry point
- `Modules/` and `Modules (Host-only)/` — Core and host-specific logic
- `Widgets/` — Feature modules using core modules

## Integration & Extensibility
- All cross-component communication must go through Flowgate. Future changes to connection methods should be isolated to Flowgate.
- Reusable functions must be centralized in modules, not duplicated.

## Plugabilidade e Abstração de Conexão

- O Flowgate funciona como um "plug" para múltiplos métodos de conexão (ex: WebRTC, WebSocket, etc.), permitindo que o método de comunicação seja trocado sem impactar os módulos ou widgets.
- Da mesma forma, a conexão com o dispositivo pode alternar entre diferentes tecnologias (ex: Serial porta COM, Bluetooth) sem quebrar a lógica dos módulos.
- Toda troca de backend de conexão (tanto Flowgate quanto Serial/Bluetooth) deve ser feita de forma transparente, mantendo a integridade e funcionamento do app, sem exigir alterações nos módulos consumidores.
- Sempre centralize e abstraia a lógica de troca de conexão em módulos dedicados (ex: Flowgate, Serial_Connection), nunca diretamente nos widgets ou módulos de negócio.

## Papéis: Visitante, Host e Host-Hub

- **Visitante:** Usuário conectado à sessão, pode enviar comandos e receber atualizações de estado, mas não tem permissão para iniciar ou controlar conexões seriais. Visitantes dependem do Host-Hub para sincronização e execução de comandos no dispositivo.
- **Host:** Usuário responsável por iniciar e gerenciar a conexão serial com o firmware. O Host apenas executa comandos recebidos do Host-Hub no hardware conectado, sem autoridade sobre o estado global.
- **Host-Hub:** Única autoridade do estado e responsável por propagar atualizações para todos. Atua como ponto central de múltiplos Hosts, coordenando sessões, roteando comandos e sincronizando estados entre diferentes Hosts e visitantes. O Host-Hub pode ser usado para escalabilidade, redundância ou integração multi-dispositivo. Caso o hub desconecte, hosts secundários tornam-se candidatos à eleição de novo host-hub.

Hierarquia: Host-Hub (autoridade do estado, nível superior de orquestração) > Host (executa comandos no dispositivo) > Visitante (usuário comum).

---
For further details, see comments in module files. When in doubt, prefer modularity, clear role separation, and deterministic sync via Flowgate.
