/*
  ESP32 Dual-Core: BLE RX -> Queue -> Core1 RF Task -> 433MHz TX
  --------------------------------------------------------------
  Core 0 (Arduino loop): NimBLE stack, BLE notify TX, OLED UI, advertising watchdog
  Core 1 (High prio): RF bit-banging + Engine (HOLDON/CADENCE/PATTERN/SEQUENCE)

  - BLE UART (NUS)
    Service: 6e400001-b5a3-f393-e0a9-e50e24dcca9e
    RX write: 6e400002...
    TX notify: 6e400003...

  - "Permissivo": Just Works + bonding habilitado, sem bloquear comandos por criptografia.

  - Safety: se BLE desconectar -> solicita HOLDOFF imediato no Core1.

  - OLED: U8g2 + ícone BT via XBM.

  Requisitos:
  - ESP32 "clássico" dual-core (WROOM/WROVER).
  - Arduino-ESP32 2.x (recomendado).
  - NimBLE-Arduino instalado.
*/

#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>

#include <NimBLEDevice.h>
#include <NimBLEServer.h>

// ---------------------
// Pinos / Constantes
// ---------------------
#define TX_PIN 25
#define LED_BUILTIN 2

#define LED_AZUL_PIN      16
#define LED_VERMELHO_PIN  17
#define LED_AMARELO_PIN   18
#define LED_VERDE_PIN     19
#define BTN_PIN           0

static const uint16_t PULSE_MS_DEFAULT = 180;
static const uint16_t MIN_GAP_MS       = 50;
static const uint8_t  SINGLE_SHOT_FRAMES_DEFAULT = 2;
static const uint16_t SINGLE_SHOT_GAP_MS         = 6;

static const char* FIXED_ID_BITS = "00110101001000100";

// ---------------------
// RF / Frame
// ---------------------
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
static inline void sendPreamble_body() { txHigh(PREAMBLE_HIGH_US); txLow(T_LONG_US); }
static inline void sendBit_body(bool one) {
  if (one) { txHigh(T_LONG_US);  txLow(T_SHORT_US); }
  else     { txHigh(T_SHORT_US); txLow(T_LONG_US ); }
}

static void setBitMSB(uint64_t &word, uint8_t idxFromMSB, bool value, uint8_t totalBits = 41) {
  uint8_t shift = totalBits - 1 - idxFromMSB;
  uint64_t mask = (uint64_t)1 << shift;
  if (value) word |= mask; else word &= ~mask;
}
static uint8_t bitsStringToWord(const char* bits, uint64_t &outWord) {
  outWord = 0ULL; uint8_t n = 0;
  for (const char* p = bits; *p; ++p) {
    if (*p=='0' || *p=='1') { outWord = (outWord<<1) | (uint64_t)(*p=='1'); n++; }
  }
  return n;
}
static bool modeToAK(const char* mode, uint8_t &a4, uint8_t &k4) {
  if (!strcmp(mode, "SHOCK"))     { a4=0b0111; k4=0b0001; return true; }
  if (!strcmp(mode, "VIBRATION")) { a4=0b1011; k4=0b0010; return true; }
  if (!strcmp(mode, "BEEP"))      { a4=0b1101; k4=0b0100; return true; }
  if (!strcmp(mode, "LIGHT"))     { a4=0b1110; k4=0b1000; return true; }
  return false;
}
static uint8_t channelToDDD(uint8_t ch) { return (ch == 1) ? 0b111 : 0b000; }

static uint64_t composeFrame(const char* mode, uint8_t level, uint8_t channel) {
  level = constrain(level, 0, 100);
  uint8_t a4, k4;
  if (!modeToAK(mode, a4, k4)) { a4 = 0; k4 = 0; }

  uint64_t idWord = 0;
  bitsStringToWord(FIXED_ID_BITS, idWord);

  uint8_t ddd = channelToDDD(channel);
  uint8_t bbb = (~ddd) & 0b111;

  uint64_t frame = 0ULL;
  setBitMSB(frame, 0, true);
  for (uint8_t i=0;i<3;i++)  setBitMSB(frame, 1+i,  (bbb>>(2-i))&1);
  for (uint8_t i=0;i<4;i++)  setBitMSB(frame, 4+i,  (k4 >>(3-i))&1);
  for (uint8_t i=0;i<17;i++) setBitMSB(frame, 8+i,  (idWord>>(16-i))&1ULL);
  for (uint8_t i=0;i<7;i++)  setBitMSB(frame, 25+i, (level>>(6-i))&1);
  for (uint8_t i=0;i<4;i++)  setBitMSB(frame, 32+i, (a4 >>(3-i))&1);
  for (uint8_t i=0;i<3;i++)  setBitMSB(frame, 36+i, (ddd>>(2-i))&1);
  setBitMSB(frame, 39, false);
  setBitMSB(frame, 40, false);
  return frame;
}

static void sendFrame_once(uint64_t frame) {
  rfLed(true);
  sendPreamble_body();
  for (int i=0;i<41;i++){
    bool bit = (frame >> (40 - i)) & 1ULL;
    sendBit_body(bit);
  }
  txLow(T_LONG_US);
  rfLed(false);
}

static void sendCommandBurst(uint64_t frame, uint8_t times = SINGLE_SHOT_FRAMES_DEFAULT) {
  for (uint8_t i=0;i<times;i++){
    sendFrame_once(frame);
    if (i+1 < times) delay(SINGLE_SHOT_GAP_MS);
  }
}

// ---------------------
// Engine (Core1 only)
// ---------------------
enum StepKind : uint8_t { STEP_ON_HOLD_MS, STEP_OFF_MS };
struct Step { StepKind kind; uint32_t ms; uint64_t frame; };

static Step     steps[64];
static uint8_t  stepCount = 0;
static uint8_t  stepIdx   = 0;
static bool     engineActive = false;
static bool     engineRepeat = false;
static uint32_t stepEndAt_ms = 0;

static bool capturingSeq = false;
static bool seqRepeatOnEnd = false;
static String seqLines[20];
static uint8_t seqCount = 0;

static void engineClear() { stepCount = 0; stepIdx = 0; engineActive = false; engineRepeat = false; }
static void engineStop() { engineActive = false; }

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

// ---------------------
// Parsers
// ---------------------
static bool parseSimpleCmd(const String& lineIn, char* outMode, uint8_t &outLvl, uint8_t &outCh, uint16_t &outMsOpt){
  outMode[0]=0; outLvl=0; outCh=1; outMsOpt=PULSE_MS_DEFAULT;

  String line = lineIn;
  line.replace("\r", "");
  line.trim();
  if (!line.length()) return false;

  int p1 = line.indexOf(',');
  int p2 = (p1 >= 0) ? line.indexOf(',', p1+1) : -1;
  int p3 = (p2 >= 0) ? line.indexOf(',', p2+1) : -1;
  if (p1 < 0 || p2 < 0) return false;

  String m = line.substring(0, p1); m.trim(); m.toUpperCase();
  if (!(m=="SHOCK"||m=="VIBRATION"||m=="BEEP"||m=="LIGHT")) return false;

  String lvlStr = line.substring(p1+1, p2); lvlStr.trim();
  String chStr  = (p3 >=0) ? line.substring(p2+1, p3) : line.substring(p2+1); chStr.trim();
  String msStr  = (p3 >=0) ? line.substring(p3+1) : String(PULSE_MS_DEFAULT);

  uint8_t lvl = (uint8_t)constrain(lvlStr.toInt(), 0, 100);
  uint8_t ch  = (uint8_t)((chStr.toInt()==2) ? 2 : 1);

  int msVal = msStr.toInt();
  uint16_t dur = (uint16_t)((msVal > (int)MIN_GAP_MS) ? msVal : (int)MIN_GAP_MS);

  m.toCharArray(outMode, 16);
  outLvl = lvl; outCh = ch; outMsOpt = dur;
  return true;
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
  if (!(m=="SHOCK"||m=="VIBRATION"||m=="BEEP"||m=="LIGHT")) return false;

  uint8_t lvl = (uint8_t)constrain(args.substring(p1+1,p2).toInt(), 0, 100);
  uint8_t ch  = (uint8_t)((args.substring(p2+1,p3).toInt()==2) ? 2 : 1);
  int repsInt = args.substring(p3+1,p4).toInt();
  uint8_t reps = (uint8_t)((repsInt>1)?repsInt:1);
  int gapInt = args.substring(p4+1).toInt();
  uint16_t gap = (uint16_t)((gapInt>(int)MIN_GAP_MS)?gapInt:(int)MIN_GAP_MS);

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

  char mode[16]; uint8_t lvl=0, ch=1; uint16_t ms=0;
  if (!parseSimpleCmd(cmd, mode, lvl, ch, ms)) return false;

  uint64_t frame = composeFrame(mode, lvl, ch);
  bool on = true;
  int idx = 0;

  while (idx <= list.length()){
    int comma = list.indexOf(',', idx);
    String tok = (comma>=0) ? list.substring(idx, comma) : list.substring(idx);
    tok.trim();
    if (tok.length()){
      int durInt = tok.toInt();
      uint16_t dur = (uint16_t)((durInt>(int)MIN_GAP_MS)?durInt:(int)MIN_GAP_MS);
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
    String ln = seqLines[i];
    ln.replace("\r","");
    ln.trim();
    if (!ln.length()) continue;

    String up = ln; up.toUpperCase();
    if (up.startsWith("CADENCE ")) {
      if (!compile_CADENCE(ln)) return false;
    } else if (up.startsWith("PATTERN ")) {
      if (!compile_PATTERN(ln)) return false;
    } else {
      char mode[16]; uint8_t lvl=0, ch=1; uint16_t ms=PULSE_MS_DEFAULT;
      if (!parseSimpleCmd(ln, mode, lvl, ch, ms)) continue;
      uint64_t frame = composeFrame(mode, lvl, ch);
      engineAddOn(frame, ms);
      engineAddOff(MIN_GAP_MS);
    }
  }
  return (stepCount > 0);
}

// ---------------------
// BLE UART (NUS)
// ---------------------
#define NUS_SERVICE_UUID  "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define NUS_CHAR_RX_UUID  "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define NUS_CHAR_TX_UUID  "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

static NimBLECharacteristic* pTxCharacteristic = nullptr;
static volatile bool deviceConnected = false;
static volatile bool bleBonded = false;
static volatile bool bleEncrypted = false;

// ---------------------
// Dual-core queues
// ---------------------
static QueueHandle_t qCmd = nullptr;   // BLE RX -> Core1
static QueueHandle_t qTx  = nullptr;   // Core1 -> Core0 notify

static TaskHandle_t rfTaskHandle = nullptr;
static volatile bool safetyStopRequested = false;

struct CmdMsg {
  char line[96];
};

struct TxMsg {
  char text[120];
};

static bool enqueueCmdFromISRorCB(const char* s) {
  if (!qCmd) return false;
  CmdMsg m;
  memset(&m, 0, sizeof(m));
  strncpy(m.line, s, sizeof(m.line)-1);
  return xQueueSend(qCmd, &m, 0) == pdTRUE;
}

static void enqueueTx(const char* s) {
  if (!qTx) return;
  TxMsg m;
  memset(&m, 0, sizeof(m));
  strncpy(m.text, s, sizeof(m.text)-2);
  size_t n = strlen(m.text);
  if (n == 0 || m.text[n-1] != '\n') {
    m.text[n] = '\n';
    m.text[n+1] = 0;
  }
  xQueueSend(qTx, &m, 0);
}

// ---------------------
// OLED (U8g2)
// ---------------------
// SSD1306 128x64 I2C
U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

static bool oledOk = false;
static unsigned long oledNextMs = 0;
static const unsigned long OLED_PERIOD_MS = 150;

// compartilhado Core1 -> Core0 (simples/leve)
static portMUX_TYPE uiMux = portMUX_INITIALIZER_UNLOCKED;
static char uiMode[12] = "IDLE";
static uint8_t uiLvl = 0;
static uint8_t uiCh  = 1;
static char uiLine[48] = "Aguardando BLE...";

static void uiSetMLC(const char* mode, uint8_t lvl, uint8_t ch) {
  portENTER_CRITICAL(&uiMux);
  strncpy(uiMode, mode, sizeof(uiMode)-1);
  uiMode[sizeof(uiMode)-1] = 0;
  uiLvl = lvl;
  uiCh  = ch;
  portEXIT_CRITICAL(&uiMux);
}
static void uiLogLine(const char* s) {
  portENTER_CRITICAL(&uiMux);
  strncpy(uiLine, s, sizeof(uiLine)-1);
  uiLine[sizeof(uiLine)-1] = 0;
  portEXIT_CRITICAL(&uiMux);
}

// 12x12 BT icon
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
};

static void oledDrawBtIcon() {
  const int w=12, h=12;
  const int x = 128 - w - 2;
  const int y = 1;

  static uint32_t lastBlink=0;
  static bool blink=false;
  bool connecting = !deviceConnected;
  if (connecting && (millis()-lastBlink > 200)) { blink=!blink; lastBlink=millis(); }

  bool draw = deviceConnected || !connecting || blink;
  if (draw) u8g2.drawXBM(x, y, w, h, bt_icon_bits);

  if (deviceConnected) u8g2.drawDisc(x+6, y+14, 2);
  else if (connecting && blink) u8g2.drawCircle(x+6, y+14, 2);
}

static void oledService(){
  if (!oledOk) return;
  unsigned long now = millis();
  if ((long)(now - oledNextMs) < 0) return;
  oledNextMs = now + OLED_PERIOD_MS;

  char mode[12]; uint8_t lvl; uint8_t ch; char line[48];
  portENTER_CRITICAL(&uiMux);
  strncpy(mode, uiMode, sizeof(mode));
  lvl = uiLvl; ch = uiCh;
  strncpy(line, uiLine, sizeof(line));
  portEXIT_CRITICAL(&uiMux);

  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_6x10_tf);

  oledDrawBtIcon();

  u8g2.setCursor(0, 10);
  u8g2.print("SCOLLAR BLE/RF");

  u8g2.setCursor(0, 22);
  u8g2.print("BLE: ");
  u8g2.print(deviceConnected ? "ON" : "OFF");
  u8g2.print(" Bond:");
  u8g2.print(bleBonded ? "Y" : "N");
  u8g2.print(" Enc:");
  u8g2.print(bleEncrypted ? "Y" : "N");

  u8g2.setCursor(0, 38);
  u8g2.print("MODE:");
  u8g2.print(mode);
  u8g2.print(" C");
  u8g2.print((unsigned)ch);
  u8g2.print(" L");
  u8g2.print((unsigned)lvl);

  u8g2.setCursor(0, 58);
  u8g2.print("> ");
  u8g2.print(line);

  u8g2.sendBuffer();
}

// ---------------------
// Safety HOLDOFF (Core1)
// ---------------------
static void safetyHoldOff_core1(){
  engineStop();
  engineClear();

  digitalWrite(TX_PIN, LOW);
  rfLed(false);
  allLedsOff();

  uiSetMLC("OFF", 0, 0);
  uiLogLine("SAFETY HOLDOFF");

  enqueueTx("OK HOLDOFF");
}

// ---------------------
// Core1: comando -> RF
// ---------------------
static void processCommandLine_core1(const char* lineC) {
  String line = String(lineC);
  line.replace("\r","");
  line.trim();
  if (!line.length()) return;

  String up = line; up.toUpperCase();

  uiLogLine(line.c_str());

  // SEQUENCE capture
  if (capturingSeq) {
    if (up.startsWith("ENDSEQ") || up.startsWith("ENDSEQUENCE")) {
      capturingSeq = false;
      stepCount = 0;
      if (compile_SEQUENCE_finalize()) {
        engineStart(seqRepeatOnEnd);
        enqueueTx("OK SEQUENCE");
        uiLogLine("OK SEQUENCE");
      } else {
        engineClear();
        enqueueTx("ERR SEQUENCE");
        uiLogLine("ERR SEQUENCE");
      }
      seqCount = 0;
      seqRepeatOnEnd = false;
      return;
    } else {
      if (seqCount < 20) {
        seqLines[seqCount++] = line;
        enqueueTx("OK LINE");
      } else {
        enqueueTx("ERR SEQUENCE FULL");
      }
      return;
    }
  }

  // PING
  if (up == "PING") {
    enqueueTx("PONG");
    return;
  }

  // HOLDOFF (manual)
  if (up.startsWith("HOLDOFF")) {
    safetyHoldOff_core1();
    return;
  }

  // HOLDON ...
  if (up.startsWith("HOLDON ")) {
    String cmd = line.substring(line.indexOf(' ') + 1);
    cmd.trim();
    String cmdUp = cmd; cmdUp.toUpperCase();

    engineClear();

    if (cmdUp.startsWith("CADENCE ")) {
      if (compile_CADENCE(cmd)) { engineStart(true); enqueueTx("OK HOLDON CADENCE"); }
      else enqueueTx("ERR HOLDON CADENCE");
      return;
    }

    if (cmdUp.startsWith("PATTERN ")) {
      if (compile_PATTERN(cmd)) { engineStart(true); enqueueTx("OK HOLDON PATTERN"); }
      else enqueueTx("ERR HOLDON PATTERN");
      return;
    }

    if (cmdUp.startsWith("SEQUENCE")) {
      capturingSeq = true;
      seqCount = 0;
      seqRepeatOnEnd = true;
      enqueueTx("OK HOLDON SEQUENCE");
      return;
    }

    // simples
    char mode[16] = {0}; uint8_t lvl=0, ch=1; uint16_t ms=PULSE_MS_DEFAULT;
    if (parseSimpleCmd(cmd, mode, lvl, ch, ms)) {
      if (!strcmp(mode, "BEEP") || !strcmp(mode, "LIGHT")) lvl = 0;
      uiSetMLC(mode, lvl, ch);

      uint64_t frame = composeFrame(mode, lvl, ch);
      engineAddOn(frame, ms);
      engineAddOff(MIN_GAP_MS);
      engineStart(true);

      char out[96];
      snprintf(out, sizeof(out), "OK HOLDON %s,%u,%u", mode, (unsigned)lvl, (unsigned)ch);
      enqueueTx(out);
    } else {
      enqueueTx("ERR HOLDON");
    }
    return;
  }

  // SEQUENCE start
  if (up.startsWith("SEQUENCE")) {
    capturingSeq = true;
    seqCount = 0;
    seqRepeatOnEnd = false;
    engineClear();
    enqueueTx("OK SEQUENCE");
    return;
  }

  // CADENCE
  if (up.startsWith("CADENCE ")) {
    engineClear();
    if (compile_CADENCE(line)) { engineStart(false); enqueueTx("OK CADENCE"); }
    else enqueueTx("ERR CADENCE");
    return;
  }

  // PATTERN
  if (up.startsWith("PATTERN ")) {
    engineClear();
    if (compile_PATTERN(line)) { engineStart(false); enqueueTx("OK PATTERN"); }
    else enqueueTx("ERR PATTERN");
    return;
  }

  // simples MODE,LVL,CH[,DUR]
  char mode[16] = {0}; uint8_t lvl=0, ch=1; uint16_t ms=PULSE_MS_DEFAULT;
  if (parseSimpleCmd(line, mode, lvl, ch, ms)) {
    if (!strcmp(mode, "BEEP") || !strcmp(mode, "LIGHT")) lvl = 0;
    uiSetMLC(mode, lvl, ch);

    uint64_t frame = composeFrame(mode, lvl, ch);
    // RF imediato (burst curto)
    sendCommandBurst(frame, SINGLE_SHOT_FRAMES_DEFAULT);

    char out[96];
    snprintf(out, sizeof(out), "OK %s,%u,%u", mode, (unsigned)lvl, (unsigned)ch);
    enqueueTx(out);
    return;
  }

  enqueueTx("ERR");
}

// Core1 task (alta prioridade)
static void rfTask(void* pv) {
  (void)pv;
  CmdMsg msg;

  for (;;) {
    // Safety stop (disconnect)
    if (safetyStopRequested) {
      safetyStopRequested = false;
      safetyHoldOff_core1();
    }

    // Prioridade: consumir comando imediatamente se houver
    if (qCmd && xQueueReceive(qCmd, &msg, 0) == pdTRUE) {
      processCommandLine_core1(msg.line);
    }

    // Engine roda no Core1
    engineService();

    // Pequeno yield (1 tick) para não matar o sistema
    vTaskDelay(1);
  }
}

// ---------------------
// BLE Callbacks (Core0)
// ---------------------
class ServerCallbacks : public NimBLEServerCallbacks {
public:
  void onConnect(NimBLEServer* s) {
    (void)s;
    deviceConnected = true;
    uiLogLine("BLE conectado");
    // não faz RF aqui
  }

  void onConnect(NimBLEServer* s, NimBLEConnInfo& ci) {
    (void)s;
    deviceConnected = true;
    bleEncrypted = ci.isEncrypted();
    bleBonded = ci.isBonded();
    uiLogLine("BLE conectado");
  }

  void onDisconnect(NimBLEServer* s) {
    (void)s;
    deviceConnected = false;
    bleEncrypted = false;
    bleBonded = false;

    // solicita safety holdoff no Core1
    safetyStopRequested = true;

    uiLogLine("BLE desconectou");

    NimBLEDevice::getAdvertising()->start();
  }

  void onDisconnect(NimBLEServer* s, NimBLEConnInfo& ci, int reason) {
    (void)s; (void)ci; (void)reason;
    deviceConnected = false;
    bleEncrypted = false;
    bleBonded = false;

    safetyStopRequested = true;
    uiLogLine("BLE desconectou");

    NimBLEDevice::getAdvertising()->start();
  }

  void onAuthenticationComplete(NimBLEConnInfo& ci) {
    bleEncrypted = ci.isEncrypted();
    bleBonded = ci.isBonded();
    uiLogLine(bleBonded ? "Pareado OK" : "Auth OK");
  }
};

class RxCallbacks : public NimBLECharacteristicCallbacks {
public:
  void onWrite(NimBLECharacteristic* c) {
    if (!c) return;
    std::string rx = c->getValue();
    if (rx.empty()) return;

    // Enfileira comando para Core1 (RF)
    String line = String(rx.c_str());
    line.replace("\r", "");
    line.trim();
    if (!line.length()) return;

    // Copia em buffer fixo (evita String entre tasks)
    char buf[96];
    memset(buf, 0, sizeof(buf));
    line.toCharArray(buf, sizeof(buf));

    enqueueCmdFromISRorCB(buf);

    // ACK rápido (opcional) - resposta real (OK/PONG/ERR) virá via qTx
    // Para reduzir latência, podemos não notificar aqui.
  }
};

// ---------------------
// BLE advertising helper
// ---------------------
static void bleStartAdvertising() {
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->stop();
  adv->addServiceUUID(NUS_SERVICE_UUID);
  adv->start();
}

// ---------------------
// setup / loop (Core0)
// ---------------------
void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(TX_PIN, OUTPUT); digitalWrite(TX_PIN, LOW);
  pinMode(LED_BUILTIN, OUTPUT); rfLed(false);

  pinMode(LED_AZUL_PIN, OUTPUT);
  pinMode(LED_VERMELHO_PIN, OUTPUT);
  pinMode(LED_AMARELO_PIN, OUTPUT);
  pinMode(LED_VERDE_PIN, OUTPUT);
  allLedsOff();

  pinMode(BTN_PIN, INPUT_PULLUP);

  // OLED
  Wire.begin();
  u8g2.begin();
  u8g2.setBusClock(400000);
  oledOk = true;

  uiLogLine("Aguardando BLE...");

  // Queues
  qCmd = xQueueCreate(16, sizeof(CmdMsg));
  qTx  = xQueueCreate(16, sizeof(TxMsg));

  // Core1 RF task (alta prioridade)
  xTaskCreatePinnedToCore(
    rfTask,
    "rfTask",
    8192,
    nullptr,
    configMAX_PRIORITIES - 1,
    &rfTaskHandle,
    1 // Core 1
  );

  // BLE init (Core0)
  NimBLEDevice::init("SCOLLAR-CONTROL-BLE");
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);

  // Just Works + bonding (reconexão silenciosa após parear, quando SO permitir)
  NimBLEDevice::setSecurityAuth(true, false, true);
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);

  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  NimBLEService* svc = server->createService(NUS_SERVICE_UUID);

  pTxCharacteristic = svc->createCharacteristic(
    NUS_CHAR_TX_UUID,
    NIMBLE_PROPERTY::NOTIFY
  );

  NimBLECharacteristic* rxChar = svc->createCharacteristic(
    NUS_CHAR_RX_UUID,
    NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
  );
  rxChar->setCallbacks(new RxCallbacks());

  svc->start();
  bleStartAdvertising();

  Serial.println("[BOOT] ready");
}

void loop() {
  // 1) drena TX queue -> notify BLE (Core0)
  if (deviceConnected && pTxCharacteristic && qTx) {
    TxMsg m;
    while (xQueueReceive(qTx, &m, 0) == pdTRUE) {
      pTxCharacteristic->setValue((uint8_t*)m.text, strlen(m.text));
      pTxCharacteristic->notify();
    }
  } else {
    // se desconectado, podemos descartar mensagens acumuladas para evitar backlog
    if (qTx) {
      TxMsg dump;
      while (xQueueReceive(qTx, &dump, 0) == pdTRUE) {}
    }
  }

  // 2) OLED (Core0)
  oledService();

  // 3) Watchdog de advertising
  static unsigned long lastKick = 0;
  if (!deviceConnected && (millis() - lastKick) > 15000) {
    NimBLEDevice::getAdvertising()->start();
    lastKick = millis();
  }

  delay(1);
}

/*
  Se seu display for SH1106, troque a linha do objeto u8g2 por:
  U8G2_SH1106_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);
*/
