# lovense-to-muse protocolo completo (extraido do codigo)

Este documento descreve exatamente como o firmware controla dispositivos MuSe/Love Spouse. Todo o conteudo foi extraido do codigo do repositorio `azy-dump/lovense-to-muse`.

## 1) Visao geral

O ESP32 executa duas funcoes simultaneas:

1. **Emulacao Lovense (BLE Server):** o ESP32 se anuncia como um Lovense Lush v1, recebe comandos via BLE GATT e interpreta mensagens do app.
2. **Controle MuSe/Love Spouse (BLE Advertising):** ao receber comandos de vibracao, o ESP32 altera o *manufacturer data* do advertising para pacotes especificos que os dispositivos MuSe interpretam como velocidade.

Nao ha conexao BLE direta com o dispositivo MuSe. O controle e feito apenas por advertising BLE com dados proprietarios.

## 2) Requisitos e dependencias

- **Plataforma:** ESP32 (board `esp32dev`)
- **Framework:** Arduino
- **BLE stack:** NimBLE-Arduino 1.4.2
- **Build:** PlatformIO

Arquivo de configuracao principal:
- `platformio.ini`

## 3) Fluxo de inicializacao

1. `Serial.begin(115200)`
2. `Lovense::init()` inicializa o servidor BLE com servico e caracteristicas Lovense.
3. `Muse::muse_init()` inicia uma task FreeRTOS que atualiza o advertising periodicamente.

Arquivo: `src/main.cpp`

## 4) Emulacao Lovense (BLE GATT)

### 4.1 Nome do dispositivo

- Nome anunciado: `LVS-LoveSpouse01`

### 4.2 Servico e caracteristicas

O firmware emula o perfil Lovense Lush v1 e usa o servico UART-like padrão da Lovense.

- **Service UUID:** `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- **Char TX UUID:** `6e400002-b5a3-f393-e0a9-e50e24dcca9e`
- **Char RX UUID:** `6e400003-b5a3-f393-e0a9-e50e24dcca9e`

Observacao do codigo:
- RX = onde o cliente **envia** dados
- TX = onde o cliente **recebe** dados

No firmware:
- **TX (WRITE/WRITE_NR):** recebe comandos do app
- **RX (NOTIFY):** envia respostas para o app

### 4.3 Propriedades das caracteristicas

- RX: `NIMBLE_PROPERTY::NOTIFY`
- TX: `NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR`

### 4.4 Comandos suportados

O parser aceita apenas duas formas:

1) **DeviceType**
```
DeviceType;
```
Resposta enviada via NOTIFY:
```
S:11:004B123A2E62;
```

2) **Vibrate**
```
Vibrate:<nivel>;
```
- `<nivel>` e um inteiro (o codigo nao valida limites antes de converter).
- O valor e convertido para intensidade MuSe (ver secao 5).
- Nao envia resposta explicita, apenas atualiza o estado do advertising.

3) **Qualquer outro comando**
```
ERR;
```

### 4.5 Servico BLE e advertising

- O servico e iniciado e anunciado por BLE advertising.
- `setScanResponse(true)` e `setMinPreferred(0x0)` sao usados.

## 5) Controle MuSe/Love Spouse via BLE Advertising

### 5.1 Conceito

A familia MuSe interpreta pacotes BLE **Manufacturer Specific Data**. O firmware altera esses dados para representar a velocidade desejada. Nao existe conexao GATT com o dispositivo MuSe.

### 5.2 Identificadores e prefixo

- **Manufacturer ID:** `0xFFF0`
- **Payload length:** 11 bytes
- **Prefixo fixo (8 bytes):**
```
6D B6 43 CE 97 FE 42 7C
```

O payload final de advertising e montado como:

```
[Manufacturer ID (2 bytes, little-endian)] + [11 bytes de dados]
```

### 5.3 Lista completa de comandos (mf_data_list)

Cada entrada tem 11 bytes: prefixo (8 bytes) + 3 bytes de comando. O indice no array e usado como valor de intensidade.

Indice | Descricao | Bytes (11)
---|---|---
0 | Stop all channels | 6D B6 43 CE 97 FE 42 7C E5 15 7D
1 | Set all channels to speed 1 | 6D B6 43 CE 97 FE 42 7C E4 9C 6C
2 | Set all channels to speed 2 | 6D B6 43 CE 97 FE 42 7C E7 07 5E
3 | Set all channels to speed 3 | 6D B6 43 CE 97 FE 42 7C E6 8E 4F
4 | Stop 1st channel (2-channel toys) | 6D B6 43 CE 97 FE 42 7C D5 96 4C
5 | Set 1st channel to speed 1 (2-channel toys) | 6D B6 43 CE 97 FE 42 7C D4 1F 5D
6 | Set 1st channel to speed 2 (2-channel toys) | 6D B6 43 CE 97 FE 42 7C D7 84 6F
7 | Set 1st channel to speed 3 (2-channel toys) | 6D B6 43 CE 97 FE 42 7C D6 0D 7E
8 | Stop 2nd channel (2-channel toys) | 6D B6 43 CE 97 FE 42 7C A5 11 3F
9 | Set 2nd channel to speed 1 (2-channel toys) | 6D B6 43 CE 97 FE 42 7C A4 98 2E
10 | Set 2nd channel to speed 2 (2-channel toys) | 6D B6 43 CE 97 FE 42 7C A7 03 1C
11 | Set 2nd channel to speed 3 (2-channel toys) | 6D B6 43 CE 97 FE 42 7C A6 8A 0D

Observacao: o firmware usa apenas os indices 0..3 para intensidade global ao receber comandos Lovense.

### 5.4 Conversao de intensidade Lovense -> MuSe

- Entrada: `lovense_intensity` (inteiro, esperado 0..20)
- Conversao para percentual:
```
percent = lovense_intensity / 20.0
```
- Conversao para MuSe (0..3):
```
index = floor(percent * 4.0)
```
Ajustes:
- Se `percent < 0.0`, ajusta para 0.
- Se `percent > 1.0`, ajusta para 1.0 (equivalente a 3).
- Se `percent` for NaN, ajusta para 0.
- Se `index == 4`, ajusta para 3.

Resultado final: `index` varia entre 0 e 3, mapeando para os comandos `Stop`, `Speed 1`, `Speed 2`, `Speed 3`.

### 5.5 Atualizacao do advertising

- Uma task FreeRTOS (`advertising_task`) roda em loop.
- A cada 100 ms, o firmware aplica o comando atual com `set_manufacturer_data(index)`.
- Quando `_stopping` e ativado (nao usado no codigo atual), a task envia `Stop all channels` 10 vezes com intervalo de 200 ms e encerra.

## 6) Como controlar (passo a passo)

1. **Conectar ao BLE do ESP32** anunciado como `LVS-LoveSpouse01`.
2. **Descobrir o servico** `6e400001-b5a3-f393-e0a9-e50e24dcca9e`.
3. **Escrever comandos** na caracteristica `6e400002-b5a3-f393-e0a9-e50e24dcca9e` (TX) com `WRITE` ou `WRITE_NR`.
4. **Receber respostas** via NOTIFY na caracteristica `6e400003-b5a3-f393-e0a9-e50e24dcca9e` (RX).
5. **Para vibrar**, enviar `Vibrate:<nivel>;`.

Exemplos de comandos:
```
DeviceType;
Vibrate:0;
Vibrate:10;
Vibrate:20;
```

## 7) Limitacoes conhecidas do firmware

- Apenas dois comandos Lovense sao processados (`DeviceType;` e `Vibrate:`).
- Nao ha autenticacao nem controle de sessao.
- O controle MuSe e **somente por advertising**, sem GATT.
- A emulacao e do Lovense Lush v1; outros modelos nao sao tratados explicitamente.
- Nao ha mapeamento para os comandos de canais separados (indices 4..11), embora os bytes estejam documentados.

## 8) Origem exata dos dados

- `lib/lovense/lovense.hpp` (UUIDs, nome, callbacks)
- `lib/lovense/lovense.cpp` (parser, comandos e resposta)
- `lib/muse/muse.hpp` (constantes e interface)
- `lib/muse/muse.cpp` (manufacturer data e mapeamento)
- `src/main.cpp` (init do sistema)

Se quiser, posso gerar um segundo documento com exemplos de codigo para um cliente BLE (ex: Python, Node, Flutter) que envia os comandos exatos descritos aqui.
