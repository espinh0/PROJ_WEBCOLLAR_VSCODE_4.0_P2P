/*
  PET998DR TX (ESP32 BLE UART)
  Versão BLE para comunicação com Web Bluetooth/Web Serial via navegador.
  Serviço BLE UART customizado (Nordic UART Service - NUS compatible)
  Lógica de RF, LEDs e comandos migrada do firmware original.
*/



#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <NimBLEDevice.h>
#include <NimBLEServer.h>
#include "epd_bitmap.h"

// --- Constantes e pinos ---
#define TX_PIN 25
#define LED_AZUL_PIN      16
#define LED_VERMELHO_PIN  17
#define LED_AMARELO_PIN   18
#define LED_VERDE_PIN     19
#define LED_BUILTIN       2
#define BTN_PIN           0

volatile unsigned int INTERFRAME_GAP_US = 800;
static const unsigned long HOLD_PERIOD_US = 50000UL;
static const uint16_t PULSE_MS_DEFAULT = 180;
static const uint16_t MIN_GAP_MS       = 50;
static const uint8_t  SINGLE_SHOT_FRAMES_DEFAULT = 2;
static const uint16_t SINGLE_SHOT_GAP_MS         = 6;
static const char* FIXED_ID_BITS = "00110101001000100";

// --- RF/Frame ---
#define PREAMBLE_HIGH_US  1400
#define T_LONG_US         710
#define T_SHORT_US        350

static inline void rfLed(bool on){ digitalWrite(LED_BUILTIN, on ? HIGH : LOW); }
static inline void azulLed(bool on){ digitalWrite(LED_AZUL_PIN, on ? HIGH : LOW); }
static inline void vermelhoLed(bool on){ digitalWrite(LED_VERMELHO_PIN, on ? HIGH : LOW); }
static inline void amareloLed(bool on){ digitalWrite(LED_AMARELO_PIN, on ? HIGH : LOW); }
static inline void verdeLed(bool on){ digitalWrite(LED_VERDE_PIN, on ? HIGH : LOW); }
static void allLedsOff() { azulLed(false); vermelhoLed(false); amareloLed(false); verdeLed(false); }

static inline void txHigh(unsigned int us) { digitalWrite(TX_PIN, HIGH); delayMicroseconds(us); }
static inline void txLow (unsigned int us) { digitalWrite(TX_PIN, LOW ); delayMicroseconds(us); }
static inline void sendPreamble_body() { txHigh(PREAMBLE_HIGH_US); txLow (T_LONG_US); }
static inline void sendBit_body(bool one) { if (one) { txHigh(T_LONG_US);  txLow(T_SHORT_US); } else { txHigh(T_SHORT_US); txLow(T_LONG_US ); } }
static void setBitMSB(uint64_t &word, uint8_t idxFromMSB, bool value, uint8_t totalBits = 41) { uint8_t shift = totalBits - 1 - idxFromMSB; uint64_t mask = (uint64_t)1 << shift; if (value) word |= mask; else word &= ~mask; }
static uint8_t bitsStringToWord(const char* bits, uint64_t &outWord) { outWord = 0ULL; uint8_t n = 0; for (const char* p = bits; *p; ++p) { if (*p == '0' || *p == '1') { outWord = (outWord << 1) | (uint64_t)(*p == '1'); n++; } } return n; }
static bool modeToAK(const char* mode, uint8_t &a4, uint8_t &k4) { if (!strcmp(mode, "SHOCK")) { a4 = 0b0111; k4 = 0b0001; return true; } if (!strcmp(mode, "VIBRATION")) { a4 = 0b1011; k4 = 0b0010; return true; } if (!strcmp(mode, "BEEP")) { a4 = 0b1101; k4 = 0b0100; return true; } if (!strcmp(mode, "LIGHT")) { a4 = 0b1110; k4 = 0b1000; return true; } return false; }
static uint8_t channelToDDD(uint8_t ch) { return (ch == 1) ? 0b111 : 0b000; }
static uint64_t composeFrame(const char* mode, uint8_t level, uint8_t channel) { level = constrain(level, 0, 100); uint8_t a4, k4; if (!modeToAK(mode, a4, k4)) { a4 = 0; k4 = 0; } uint64_t idWord = 0; bitsStringToWord(FIXED_ID_BITS, idWord); uint8_t ddd = channelToDDD(channel); uint8_t bbb = (~ddd) & 0b111; uint64_t frame = 0ULL; setBitMSB(frame, 0, true); for (uint8_t i = 0; i < 3; ++i) setBitMSB(frame, 1 + i, (bbb >> (2 - i)) & 1); for (uint8_t i = 0; i < 4; ++i) setBitMSB(frame, 4 + i, (k4  >> (3 - i)) & 1); for (uint8_t i = 0; i < 17; ++i) setBitMSB(frame, 8 + i, (idWord >> (16 - i)) & 1ULL); for (uint8_t i = 0; i < 7; ++i) setBitMSB(frame, 25 + i, (level >> (6 - i)) & 1); for (uint8_t i = 0; i < 4; ++i) setBitMSB(frame, 32 + i, (a4   >> (3 - i)) & 1); for (uint8_t i = 0; i < 3; ++i) setBitMSB(frame, 36 + i, (ddd >> (2 - i)) & 1); setBitMSB(frame, 39, false); setBitMSB(frame, 40, false); return frame; }

// --- Função para transmitir um frame RF ---
static void sendFrame_once(uint64_t frame) {
  rfLed(true);
  sendPreamble_body();
  for (int i = 0; i < 41; ++i) {
    bool bit = (frame >> (40 - i)) & 1ULL;
    sendBit_body(bit);
  }
  txLow(T_LONG_US);
  rfLed(false);
}


// --- shouldTransmit dummy (pode ser ajustado conforme lógica desejada) ---
static bool shouldTransmit(const char* mode, uint8_t lvl) { return true; }

// --- Função para enviar burst de comandos RF ---
static void sendCommandBurst(uint64_t frame, uint8_t times = SINGLE_SHOT_FRAMES_DEFAULT) {
  for (uint8_t i = 0; i < times; ++i) {
    sendFrame_once(frame);
    if (i + 1 < times) delay(SINGLE_SHOT_GAP_MS);
  }
}

// ====== Engine de Passos e Playlists ======
enum StepKind : uint8_t { STEP_ON_HOLD_MS, STEP_OFF_MS };
struct Step { StepKind kind; uint32_t ms; uint64_t frame; };
static Step     steps[64];
static uint8_t  stepCount = 0;
static uint8_t  stepIdx   = 0;
static bool     engineActive = false;
static bool     engineRepeat = false;
static uint32_t stepEndAt_ms = 0;
static bool     capturingSeq = false;
static bool     seqRepeatOnEnd = false;
static String   seqLines[20];
static uint8_t  seqCount = 0;

static void engineClear() { stepCount = 0; stepIdx = 0; engineActive = false; engineRepeat = false; }
static bool engineAddOn(uint64_t frame, uint32_t ms){
  if (stepCount >= 64) return false;
  steps[stepCount++] = Step{ STEP_ON_HOLD_MS, ms, frame };
  return true;
}
static bool engineAddOff(uint32_t ms){
  if (stepCount >= 64) return false;
  steps[stepCount++] = Step{ STEP_OFF_MS, ms, 0ULL };
  return true;
}
static void engineStart(bool repeat){
  if (!stepCount) return;
  engineRepeat = repeat;
  engineActive = true;
  stepIdx = 0;
  if (steps[0].kind == STEP_ON_HOLD_MS) sendFrame_once(steps[0].frame);
  stepEndAt_ms = millis() + steps[0].ms;
}
static void engineStop(){ engineActive = false; }
static void engineService(){
  if (!engineActive) return;
  unsigned long now = millis();
  if ((long)(now - stepEndAt_ms) < 0) return;
  stepIdx++;
  if (stepIdx >= stepCount){
    if (engineRepeat) stepIdx = 0;
    else { engineStop(); return; }
  }
  const Step& s = steps[stepIdx];
  if (s.kind == STEP_ON_HOLD_MS) sendFrame_once(s.frame);
  stepEndAt_ms = millis() + s.ms;
}

// ====== Parsers/Compiladores ======
static bool parseSimpleCmd(const String& line, char* outMode, uint8_t &outLvl, uint8_t &outCh, uint16_t &outMsOpt){
  outMode[0]=0; outLvl=0; outCh=1; outMsOpt=PULSE_MS_DEFAULT;
  int p1 = line.indexOf(',');
  int p2 = (p1 >= 0) ? line.indexOf(',', p1+1) : -1;
  int p3 = (p2 >= 0) ? line.indexOf(',', p2+1) : -1;
  if (p1 < 0 || p2 < 0) return false;
  String m = line.substring(0, p1); m.trim(); m.toUpperCase();
  String lvlStr = line.substring(p1+1, p2); lvlStr.trim();
  String chStr  = (p3 >=0) ? line.substring(p2+1, p3) : line.substring(p2+1); chStr.trim();
  String msStr  = (p3 >=0) ? line.substring(p3+1) : String(PULSE_MS_DEFAULT);
  uint8_t lvl = (uint8_t) constrain(lvlStr.toInt(), 0, 100);
  uint8_t ch  = (uint8_t) ((chStr.length() ? chStr.toInt() : 1) == 2 ? 2 : 1);
  int msVal = msStr.toInt();
  uint16_t dur = (uint16_t)((msVal > (int)MIN_GAP_MS) ? msVal : (int)MIN_GAP_MS);
  if (!(m=="SHOCK"||m=="VIBRATION"||m=="BEEP"||m=="LIGHT")) return false;
  m.toCharArray(outMode, 16);
  outLvl= lvl;
  outCh = ch;
  outMsOpt = dur;
  return true;
}
static void compile_SIMPLE_into_playlist(const String& cmdLine){
  char mode[16]; uint8_t lvl=0, ch=1; uint16_t durMs=PULSE_MS_DEFAULT;
  if (!parseSimpleCmd(cmdLine, mode, lvl, ch, durMs)) return;
  if (!shouldTransmit(mode, lvl)) return;
  uint64_t frame = composeFrame(mode, lvl, ch);
  engineAddOn(frame, durMs);
  engineAddOff(MIN_GAP_MS);
}
static bool compile_CADENCE(const String& line){
  int sp = line.indexOf(' ');
  if (sp < 0) return false;
  String args = line.substring(sp+1); args.trim();
  int p1 = args.indexOf(',');
  int p2 = args.indexOf(',', p1+1);
  int p3 = args.indexOf(',', p2+1);
  int p4 = args.indexOf(',', p3+1);
  if (p1<0||p2<0||p3<0||p4<0) return false;
  String m = args.substring(0,p1); m.trim(); m.toUpperCase();
  uint8_t lvl = constrain(args.substring(p1+1,p2).toInt(), 0, 100);
  uint8_t ch  = constrain(args.substring(p2+1,p3).toInt(), 1, 2);
  int repsInt = args.substring(p3+1,p4).toInt();
  uint8_t reps= (uint8_t)((repsInt > 1) ? repsInt : 1);
  int gapInt = args.substring(p4+1).toInt();
  uint16_t gap= (uint16_t)((gapInt > (int)MIN_GAP_MS) ? gapInt : (int)MIN_GAP_MS);
  if (!(m=="SHOCK"||m=="VIBRATION"||m=="BEEP"||m=="LIGHT")) return false;
  uint64_t frame = composeFrame(m.c_str(), lvl, ch);
  for (uint8_t i=0;i<reps;i++){
    engineAddOn(frame, PULSE_MS_DEFAULT);
    engineAddOff(gap);
  }
  return true;
}
static bool compile_PATTERN(const String& line){
  int sp = line.indexOf(' ');
  if (sp < 0) return false;
  String rest = line.substring(sp+1); rest.trim();
  int brOpen = rest.indexOf('[');
  int brClose= rest.lastIndexOf(']');
  if (brOpen < 0 || brClose < brOpen) return false;
  String cmd = rest.substring(0, brOpen); cmd.trim();
  String list= rest.substring(brOpen+1, brClose); list.trim();
  char mode[16]; uint8_t lvl=0, ch=1; uint16_t _msDummy=0;
  if (!parseSimpleCmd(cmd, mode, lvl, ch, _msDummy)) return false;
  if (!shouldTransmit(mode, lvl)) return true;
  uint64_t frame = composeFrame(mode, lvl, ch);
  bool on = true;
  int idx = 0;
  while (idx <= list.length()){
    int comma = list.indexOf(',', idx);
    String tok = (comma>=0) ? list.substring(idx, comma) : list.substring(idx);
    tok.trim();
    if (tok.length()){
      int durInt = tok.toInt();
      uint16_t dur = (uint16_t)((durInt > (int)MIN_GAP_MS) ? durInt : (int)MIN_GAP_MS);
      if (on) engineAddOn(frame, dur);
      else    engineAddOff(dur);
      on = !on;
    }
    if (comma < 0) break;
    idx = comma + 1;
  }
  return true;
}
static bool compile_SEQUENCE_finalize(){
  for (uint8_t i=0;i<seqCount;i++){
    String ln = seqLines[i]; ln.trim();
    if (!ln.length()) continue;
    if (ln.startsWith("CADENCE") || ln.startsWith("Cadence") || ln.startsWith("cadence")){
      if (!compile_CADENCE(ln)) return false;
    }
    else if (ln.startsWith("PATTERN") || ln.startsWith("Pattern") || ln.startsWith("pattern")){
      if (!compile_PATTERN(ln)) return false;
    }
    else {
      compile_SIMPLE_into_playlist(ln);
    }
  }
  return (stepCount > 0);
}

// --- BLE PIN (Passkey) ---
#define BLE_PASSKEY 123456

// --- OLED ---
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1
#define OLED_ADDR     0x3C
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// Removido: duplicatas de oledShowStatus e oledShowCmd





// --- UUIDs BLE UART ---
#define SERVICE_UUID        "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define CHARACTERISTIC_RX   "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define CHARACTERISTIC_TX   "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

// --- Variáveis globais BLE (apenas UMA definição, ANTES de tudo) ---
NimBLECharacteristic* pTxCharacteristic = nullptr;
volatile bool deviceConnected = false;

// --- OLED Integration (compatível com firmware_ESP32.ino) ---
static bool oledOk = false;
static unsigned long oledNextMs = 0;
static const unsigned long OLED_PERIOD_MS = 150;
static char lastMode[12] = "IDLE";
static uint8_t lastLvl = 0;
static uint8_t lastCh  = 1;
static char lastLine[48] = "";
static unsigned long lastCmdMs = 0;
// --- Animação: linha de 20x1 pixels rodando ao redor da tela ---
static uint16_t animPos = 0;
static uint8_t animEdge = 0; // 0:top, 1:right, 2:bottom, 3:left

// --- Ícone Bluetooth (U8G2 style, 12x12 px) ---
static const uint8_t bt_icon_bits[] PROGMEM = {
  0x08, 0x00,
  0x18, 0x00,
  0x1C, 0x00,
  0x16, 0x00,
  0x13, 0x00,
  0x11, 0x80,
  0x13, 0x00,
  0x16, 0x00,
  0x1C, 0x00,
  0x18, 0x00,
  0x08, 0x00,
  0x00, 0x00
}; // 12x12 px, formato U8G2 (bitmap simples)

// Estado de animação do Bluetooth
static uint8_t btAnimFrame = 0;
static unsigned long btAnimLastMs = 0;
static bool btConnecting = false;

  void oledLogLine(const String& s){ s.toCharArray(lastLine, sizeof(lastLine)); lastCmdMs = millis(); }
  void oledSetMLC(const char* mode, uint8_t lvl, uint8_t ch){ strncpy(lastMode, mode, sizeof(lastMode)-1); lastMode[sizeof(lastMode)-1] = 0; lastLvl = lvl; lastCh = ch; }
  void oledShowStatus(const char* status) { oledLogLine(status); }
  void oledShowCmd(const char* cmd) { oledLogLine(cmd); }

  void oledDrawAnimation() {
    // 128x64, linha de 20x1 pixels
    const uint8_t w = 20, h = 1;
    uint8_t x=0, y=0;
    switch (animEdge) {
      case 0: // Top
        x = animPos; y = 0;
        display.fillRect(x, y, w, h, SSD1306_WHITE);
        break;
      case 1: // Right
        x = 128-h; y = animPos;
        display.fillRect(x, y, h, w, SSD1306_WHITE);
        break;
      case 2: // Bottom
        x = 128-animPos-w; y = 64-h;
        display.fillRect(x, y, w, h, SSD1306_WHITE);
        break;
      case 3: // Left
        x = 0; y = 64-animPos-w;
        display.fillRect(x, y, h, w, SSD1306_WHITE);
        break;
    }
    // Atualiza posição para próximo frame
    animPos += 8; // velocidade
    if (animEdge == 0 || animEdge == 2) {
      if (animPos > 128-w) { animPos = 0; animEdge = (animEdge+1)%4; }
    } else {
      if (animPos > 64-w) { animPos = 0; animEdge = (animEdge+1)%4; }
    }
  }

  void oledDrawBluetoothIcon() {
    // Posição do ícone: canto superior direito
    const int iconX = 128-14;
    const int iconY = 2;
    // Efeito de animação: pisca ou "onda" ao conectar
    bool draw = true;
    if (btConnecting) {
      // Pisca a cada 200ms
      if (millis() - btAnimLastMs > 200) {
        btAnimFrame = (btAnimFrame+1)%2;
        btAnimLastMs = millis();
      }
      draw = (btAnimFrame == 0);
    }
    // Ícone azul (se display.color suportar), senão branco
    if (draw) {
      display.drawBitmap(iconX, iconY, bt_icon_bits, 12, 12, SSD1306_WHITE);
    }
    // Pequeno círculo "conectado" abaixo do ícone
    if (deviceConnected) {
      display.fillCircle(iconX+6, iconY+14, 2, SSD1306_WHITE);
    } else if (btConnecting) {
      // Círculo "pulsando" ao conectar
      if (btAnimFrame == 1) display.drawCircle(iconX+6, iconY+14, 2, SSD1306_WHITE);
    }
  }

  void oledService() {
    if (!oledOk) return;
    const unsigned long now = millis();
    if ((long)(now - oledNextMs) < 0) return;
    oledNextMs = now + OLED_PERIOD_MS;
    display.clearDisplay();
    // --- Ícone Bluetooth ---
    oledDrawBluetoothIcon();
    // --- Info principais ---
    display.setCursor(0,0);
    display.print(F("MODE: ")); display.print(lastMode); display.print(F(" CH")); display.print((unsigned)lastCh);
    display.setCursor(0,10);
    display.print(F("LVL : ")); display.print((unsigned)lastLvl);
    display.setCursor(0,20);
    display.print(F("> ")); display.print(lastLine);
    // Desenha animação
    oledDrawAnimation();
    display.display();
  }



// (Removido: duplicatas das variáveis globais BLE)

// --- BLE Callbacks ---
class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* pServer) {
    Serial.println("[DEBUG] BLE conectado!");
    deviceConnected = true;
    btConnecting = false;
    oledShowStatus("Conectado!");
  }
  void onDisconnect(NimBLEServer* pServer) {
    Serial.println("[DEBUG] BLE desconectado!");
    deviceConnected = false;
    btConnecting = true;
    oledShowStatus("Aguardando conexão...");
    NimBLEDevice::getAdvertising()->start();
  }
  void onAuthenticationComplete(ble_gap_conn_desc* desc) {
    Serial.print("[DEBUG] BLE auth complete, encrypted: ");
    Serial.println(desc->sec_state.encrypted ? "SIM" : "NÃO");
    if (!desc->sec_state.encrypted) {
      oledShowStatus("Falha PIN BLE!");
      NimBLEDevice::getServer()->disconnect(desc->conn_handle);
    }
  }
};

class RxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pCharacteristic) {
    std::string rxValue = pCharacteristic->getValue();
    String line = String(rxValue.c_str());
    Serial.print("[DEBUG] BLE RX: "); Serial.println(line);
    oledShowCmd(line.c_str());
    // --- Comando SEQUENCE multi-linha ---
    if (capturingSeq) {
      Serial.println("[DEBUG] BLE RX: capturando sequência");
      if (line.startsWith("ENDSEQ") || line.startsWith("ENDSEQUENCE")) {
        capturingSeq = false;
        stepCount = 0;
        if (compile_SEQUENCE_finalize()) {
          Serial.println("[DEBUG] BLE RX: sequência compilada e iniciada");
          engineStart(seqRepeatOnEnd);
          pTxCharacteristic->setValue("OK SEQUENCE");
        } else {
          Serial.println("[DEBUG] BLE RX: erro ao compilar sequência");
          engineClear();
          pTxCharacteristic->setValue("ERR SEQUENCE");
        }
        pTxCharacteristic->notify();
        seqCount = 0;
        seqRepeatOnEnd = false;
        return;
      } else {
        if (seqCount < 20) seqLines[seqCount++] = line;
        else pTxCharacteristic->setValue("ERR SEQUENCE");
        pTxCharacteristic->notify();
        return;
      }
    }
    // --- Comando HOLDON ---
    if (line.startsWith("HOLDON ")) {
      Serial.println("[DEBUG] BLE RX: HOLDON recebido");
      String cmd = line.substring(line.indexOf(' ') + 1); cmd.trim();
      if (cmd.startsWith("CADENCE") || cmd.startsWith("Cadence") || cmd.startsWith("cadence")) {
        Serial.println("[DEBUG] BLE RX: HOLDON CADENCE");
        engineClear();
        if (compile_CADENCE(cmd)) {
          engineStart(true);
          pTxCharacteristic->setValue("OK HOLDON CADENCE");
        } else {
          pTxCharacteristic->setValue("ERR HOLDON");
        }
        pTxCharacteristic->notify();
        return;
      } else if (cmd.startsWith("PATTERN") || cmd.startsWith("Pattern") || cmd.startsWith("pattern")) {
        Serial.println("[DEBUG] BLE RX: HOLDON PATTERN");
        engineClear();
        if (compile_PATTERN(cmd)) {
          engineStart(true);
          pTxCharacteristic->setValue("OK HOLDON PATTERN");
        } else {
          pTxCharacteristic->setValue("ERR HOLDON");
        }
        pTxCharacteristic->notify();
        return;
      } else if (cmd.startsWith("SEQUENCE") || cmd.startsWith("Sequence") || cmd.startsWith("sequence")) {
        Serial.println("[DEBUG] BLE RX: HOLDON SEQUENCE");
        capturingSeq = true; seqCount = 0; engineClear();
        seqRepeatOnEnd = true;
        pTxCharacteristic->setValue("OK HOLDON");
        pTxCharacteristic->notify();
        return;
      } else {
        char mode[16] = {0}; uint8_t lvl=0, ch=1; uint16_t _ms=0;
        if (parseSimpleCmd(cmd, mode, lvl, ch, _ms)) {
          Serial.print("[DEBUG] BLE RX: HOLDON simples modo:"); Serial.print(mode); Serial.print(", lvl:"); Serial.print(lvl); Serial.print(", ch:"); Serial.print(ch); Serial.print(", ms:"); Serial.println(_ms);
          uint64_t frame = composeFrame(mode, lvl, ch);
          engineClear();
          engineAddOn(frame, _ms);
          engineAddOff(MIN_GAP_MS);
          engineStart(true);
          pTxCharacteristic->setValue((std::string)("OK HOLDON " + String(mode) + "," + String(lvl) + "," + String(ch)).c_str());
        } else {
          Serial.println("[DEBUG] BLE RX: HOLDON simples inválido");
          pTxCharacteristic->setValue("ERR HOLDON");
        }
        pTxCharacteristic->notify();
        return;
      }
    }
    // --- Comando HOLDOFF ---
    if (line.startsWith("HOLDOFF")) {
      Serial.println("[DEBUG] BLE RX: HOLDOFF recebido");
      engineStop();
      engineClear();
      pTxCharacteristic->setValue("OK HOLDOFF");
      pTxCharacteristic->notify();
      return;
    }
    // --- Comando SEQUENCE (início) ---
    if (line.startsWith("SEQUENCE")) {
      Serial.println("[DEBUG] BLE RX: SEQUENCE início");
      capturingSeq = true; seqCount = 0; engineClear();
      seqRepeatOnEnd = false;
      pTxCharacteristic->setValue("OK SEQUENCE");
      pTxCharacteristic->notify();
      return;
    }
    // --- Comando CADENCE ---
    if (line.startsWith("CADENCE ")) {
      Serial.println("[DEBUG] BLE RX: CADENCE recebido");
      engineClear();
      if (compile_CADENCE(line)) { engineStart(false); pTxCharacteristic->setValue("OK CADENCE"); }
      else pTxCharacteristic->setValue("ERR CADENCE");
      pTxCharacteristic->notify();
      return;
    }
    // --- Comando PATTERN ---
    if (line.startsWith("PATTERN ")) {
      Serial.println("[DEBUG] BLE RX: PATTERN recebido");
      engineClear();
      if (compile_PATTERN(line)) { engineStart(false); pTxCharacteristic->setValue("OK PATTERN"); }
      else pTxCharacteristic->setValue("ERR PATTERN");
      pTxCharacteristic->notify();
      return;
    }
    // --- Comando simples: MODE,LVL,CH[,DUR] ---
    char mode[16] = {0}; uint8_t lvl=0, ch=1; uint16_t ms=PULSE_MS_DEFAULT;
    if (parseSimpleCmd(line, mode, lvl, ch, ms)) {
      Serial.print("[DEBUG] BLE RX: comando simples modo:"); Serial.print(mode); Serial.print(", lvl:"); Serial.print(lvl); Serial.print(", ch:"); Serial.print(ch); Serial.print(", ms:"); Serial.println(ms);
      if (strcmp(mode, "BEEP") == 0 || strcmp(mode, "LIGHT") == 0) lvl = 0;
      uint64_t frame = composeFrame(mode, lvl, ch);
      sendCommandBurst(frame, SINGLE_SHOT_FRAMES_DEFAULT);
      pTxCharacteristic->setValue((std::string)("OK " + String(mode) + "," + String(lvl) + "," + String(ch)).c_str());
      pTxCharacteristic->notify();
      return;
    }
    // --- Comando PING ---
    if (line.equalsIgnoreCase("PING")) {
      Serial.println("[DEBUG] BLE RX: PING recebido");
      pTxCharacteristic->setValue("PONG");
      pTxCharacteristic->notify();
      return;
    }
    // --- Comando desconhecido ---
    Serial.print("[DEBUG] BLE RX: comando desconhecido: "); Serial.println(line);
    pTxCharacteristic->setValue("ERR");
    pTxCharacteristic->notify();
  }
};

void setup() {
  Serial.begin(115200);
  Serial.println("[DEBUG] Iniciando setup...");
  pinMode(TX_PIN, OUTPUT); digitalWrite(TX_PIN, LOW);
  pinMode(LED_BUILTIN, OUTPUT); rfLed(false);
  pinMode(LED_AZUL_PIN, OUTPUT); pinMode(LED_VERMELHO_PIN, OUTPUT);
  pinMode(LED_AMARELO_PIN, OUTPUT); pinMode(LED_VERDE_PIN, OUTPUT);
  allLedsOff();
  pinMode(BTN_PIN, INPUT_PULLUP);

  // Inicializa OLED primeiro
  Serial.println("[DEBUG] Inicializando OLED...");
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println(F("Falha ao inicializar OLED!"));
  } else {
    Serial.println(F("OLED inicializado!"));
    // Exibe imagem de startup
    display.clearDisplay();
    display.drawBitmap(0, 0, epd_bitmap_Bitmap, 128, 64, SSD1306_WHITE);
    display.display();
    delay(1200);
    oledShowStatus("Aguardando conexão...");
    oledOk = true;
  }

  // Estado inicial do Bluetooth: aguardando conexão
  btConnecting = true;
  btAnimFrame = 0;
  btAnimLastMs = millis();

  Serial.println("[DEBUG] Iniciando BLE...");
  NimBLEDevice::init("SCOLLAR-CONTROL-BLE");
  NimBLEDevice::setSecurityAuth(true, true, true);
  NimBLEDevice::setSecurityPasskey(BLE_PASSKEY);
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_DISPLAY_ONLY); // ou BLE_HS_IO_NO_INPUT_OUTPUT
  NimBLEServer* pServer = NimBLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());
  NimBLEService* pService = pServer->createService(SERVICE_UUID);
  pTxCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_TX,
    NIMBLE_PROPERTY::NOTIFY
  );
  NimBLECharacteristic* pRxCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_RX,
    NIMBLE_PROPERTY::WRITE
  );
  pRxCharacteristic->setCallbacks(new RxCallbacks());
  pService->start();
  NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->start();
  NimBLEDevice::setPower(ESP_PWR_LVL_P9); // Máxima potência para estabilidade
  Serial.println("[DEBUG] BLE pronto. PIN: 123456");
}

void loop() {
  // (Opcional) Envie status periódico via BLE
  static unsigned long lastSend = 0;
  if (deviceConnected && millis() - lastSend > 5000) {
    pTxCharacteristic->setValue("OK BLE conectado");
    pTxCharacteristic->notify();
    lastSend = millis();
    oledShowStatus("Conectado!");
  }
  // Watchdog BLE: reinicia advertising se desconectado
  static unsigned long lastCheck = 0;
  if (!deviceConnected && millis() - lastCheck > 10000) {
    NimBLEDevice::getAdvertising()->start();
    lastCheck = millis();
  }
  // Atualiza estado de animação do Bluetooth
  if (deviceConnected) {
    btConnecting = false;
  } else {
    btConnecting = true;
  }
  // Engine de passos (playlists)
  engineService();
  // Atualiza tela de informações OLED
  oledService();
}
