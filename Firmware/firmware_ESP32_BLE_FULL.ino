/*
  PET998DR TX (ESP32 BLE UART)
  Versão BLE para comunicação com Web Bluetooth/Web Serial via navegador.
  Serviço BLE UART customizado (Nordic UART Service - NUS compatible)
  Lógica de RF, LEDs e comandos migrada do firmware original.
*/


#include <NimBLEDevice.h>
#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// --- OLED ---
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1
#define OLED_ADDR     0x3C
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

void oledShowStatus(const char* status) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("SCOLLAR BLE");
  display.setCursor(0, 16);
  display.println(status);
  display.display();
}

void oledShowCmd(const char* cmd) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("SCOLLAR BLE");
  display.setCursor(0, 16);
  display.println("Comando:");
  display.setCursor(0, 32);
  display.println(cmd);
  display.display();
}

// --- UUIDs BLE UART ---
#define SERVICE_UUID        "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define CHARACTERISTIC_RX   "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define CHARACTERISTIC_TX   "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

NimBLECharacteristic* pTxCharacteristic;
bool deviceConnected = false;

// --- Hardware/Pins (ajuste conforme necessário) ---
#define TX_PIN 25
#define LED_AZUL_PIN      16
#define LED_VERMELHO_PIN  17
#define LED_AMARELO_PIN   18
#define LED_VERDE_PIN     19
#define LED_BUILTIN       13
#define BTN_PIN           4
#define BTN_ON_LEVEL      LOW

// --- RF/Comando/LEDs (mesmo do firmware original) ---
const unsigned int T_SHORT_US        = 350;
const unsigned int T_LONG_US         = 710;
const unsigned int PREAMBLE_HIGH_US  = 1400;
volatile unsigned int INTERFRAME_GAP_US = 800;
static const unsigned long HOLD_PERIOD_US = 50000UL;
static const uint16_t PULSE_MS_DEFAULT = 180;
static const uint16_t MIN_GAP_MS       = 50;
static const uint8_t  SINGLE_SHOT_FRAMES_DEFAULT = 2;
static const uint16_t SINGLE_SHOT_GAP_MS         = 6;
static const char* FIXED_ID_BITS = "00110101001000100";

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
static void sendFrame_once(uint64_t frame) { rfLed(true); sendPreamble_body(); for (uint8_t i = 0; i < 41; ++i) { bool bit = (frame >> (40 - i)) & 1ULL; sendBit_body(bit); } digitalWrite(TX_PIN, LOW); delayMicroseconds(INTERFRAME_GAP_US); rfLed(false); yield(); }
static void sendCommandBurst(uint64_t frame, uint8_t times = SINGLE_SHOT_FRAMES_DEFAULT) { for (uint8_t i = 0; i < times; ++i) { sendFrame_once(frame); if (i + 1 < times) delay(SINGLE_SHOT_GAP_MS); } }

// --- BLE Callbacks ---
class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* pServer) {
    deviceConnected = true;
    oledShowStatus("Conectado!");
  }
  void onDisconnect(NimBLEServer* pServer) {
    deviceConnected = false;
    oledShowStatus("Aguardando conexão...");
  }
};

class RxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pCharacteristic) {
    std::string rxValue = pCharacteristic->getValue();
    String line = String(rxValue.c_str());
    oledShowCmd(line.c_str());
    // --- Parse comando simples: MODE,LVL,CH[,DUR] ---
    char mode[16] = {0}; uint8_t lvl=0, ch=1; uint16_t ms=PULSE_MS_DEFAULT;
    if (parseSimpleCmd(line, mode, lvl, ch, ms)) {
      if (strcmp(mode, "BEEP") == 0 || strcmp(mode, "LIGHT") == 0) lvl = 0;
      uint64_t frame = composeFrame(mode, lvl, ch);
      sendCommandBurst(frame, SINGLE_SHOT_FRAMES_DEFAULT);
      pTxCharacteristic->setValue((std::string)("OK " + String(mode) + "," + String(lvl) + "," + String(ch)).c_str());
      pTxCharacteristic->notify();
      return;
    }
    // --- Comando PING ---
    if (line.equalsIgnoreCase("PING")) {
      pTxCharacteristic->setValue("PONG");
      pTxCharacteristic->notify();
      return;
    }
    // --- Comando desconhecido ---
    pTxCharacteristic->setValue("ERR");
    pTxCharacteristic->notify();
  }
};

void setup() {
  pinMode(TX_PIN, OUTPUT); digitalWrite(TX_PIN, LOW);
  pinMode(LED_BUILTIN, OUTPUT); rfLed(false);
  pinMode(LED_AZUL_PIN, OUTPUT); pinMode(LED_VERMELHO_PIN, OUTPUT);
  pinMode(LED_AMARELO_PIN, OUTPUT); pinMode(LED_VERDE_PIN, OUTPUT);
  allLedsOff();
  pinMode(BTN_PIN, INPUT_PULLUP);
  Serial.begin(115200);

  // Inicializa OLED
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println(F("Falha ao inicializar OLED!"));
  } else {
    oledShowStatus("Aguardando conexão...");
  }

  NimBLEDevice::init("SCOLLAR-CONTROL-BLE");
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
}

// --- Função parseSimpleCmd (mesma do original) ---
bool parseSimpleCmd(const String& line, char* outMode, uint8_t &outLvl, uint8_t &outCh, uint16_t &outMsOpt){
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
