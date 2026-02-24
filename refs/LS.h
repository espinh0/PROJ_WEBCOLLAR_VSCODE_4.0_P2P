#pragma once
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <NimBLEDevice.h>
#include <cmath>

static constexpr uint16_t MANUFACTURER_ID = 0xFFF0;
static constexpr size_t MANUFACTURER_DATA_LENGTH = 11;
static constexpr uint8_t MANUFACTURER_DATA_PREFIX[8] = {0x6D, 0xB6, 0x43, 0xCE, 0x97, 0xFE, 0x42, 0x7C};

static uint8_t _intensity_value = 0;
static uint8_t _last_intensity_value = 255;
static bool _stopping = false;
static uint32_t _last_command_ms = 0;

typedef void (*muse_advdata_hook_t)(NimBLEAdvertising* adv);
static muse_advdata_hook_t _advdata_hook = nullptr;

// Auto-stop if no new command arrives for this long (ms).
// Set to 0 to disable.
static constexpr uint32_t COMMAND_TIMEOUT_MS = 1500;

// ---------------- Channel values ----------------
static constexpr uint32_t CHANNELS[] = {
    0xE50000, // Stop

    0xF40000, // L1
    0xF70000, // L2
    0xF60000, // L3
    0xF10000, // L4
    0xF00000, // L5 (New)
    0xF30000, // L6
    0xE70000, // L7
    0xFC0000, // L8 (New)
    0xE60000, // L9
};


// ---------------- Set manufacturer data ----------------
inline void set_manufacturer_data(uint8_t index) {
    NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();

    // Stop advertising before changing data
    pAdvertising->reset();
    if (_advdata_hook) {
        _advdata_hook(pAdvertising);
    }

    uint8_t data[MANUFACTURER_DATA_LENGTH];
    memcpy(data, MANUFACTURER_DATA_PREFIX, sizeof(MANUFACTURER_DATA_PREFIX));

    uint32_t channel = CHANNELS[index];
    data[8]  = (channel >> 16) & 0xFF;
    data[9]  = (channel >> 8) & 0xFF;
    data[10] = channel & 0xFF;

    uint8_t fullData[MANUFACTURER_DATA_LENGTH + 2];
    fullData[0] = MANUFACTURER_ID & 0xFF;
    fullData[1] = (MANUFACTURER_ID >> 8) & 0xFF;
    memcpy(fullData + 2, data, MANUFACTURER_DATA_LENGTH);

    pAdvertising->setManufacturerData(fullData, sizeof(fullData));
    pAdvertising->start();
}

// ---------------- Advertising hook ----------------
inline void muse_set_advdata_hook(muse_advdata_hook_t hook) { _advdata_hook = hook; }

// ---------------- BLE advertising task ----------------
inline void muse_advertising_task(void* pvParameters) {
    while (!_stopping) {
        if (COMMAND_TIMEOUT_MS > 0 && _intensity_value != 0) {
            uint32_t now = millis();
            if (now - _last_command_ms > COMMAND_TIMEOUT_MS) {
                _intensity_value = 0;
            }
        }
        if (_last_intensity_value != _intensity_value) {
            set_manufacturer_data(_intensity_value);
            _last_intensity_value = _intensity_value;
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }

    set_manufacturer_data(0); // stop
    vTaskDelete(NULL);
}

// ---------------- Set intensity ----------------
inline void muse_set_intensity(float intensity_percent) {
    if (isnan(intensity_percent) || intensity_percent < 0.0f) intensity_percent = 0.0f;
    else if (intensity_percent > 1.0f) intensity_percent = 1.0f;

    // Convert 20 Lovense levels (0-19) to our 9 vibration levels (1-9) + Stop (0)
    if (intensity_percent == 0.0f) {
        _intensity_value = 0; // Stop
    } else {
        // Map 0.05-1.0 range to 1-9 indices (our vibration levels)
        _intensity_value = static_cast<uint8_t>(round(intensity_percent * 8.0f)) + 1;
        if (_intensity_value > 9) _intensity_value = 9;
    }
    _last_command_ms = millis();
}

// ---------------- Start/Stop ----------------
inline void muse_start() {
    _stopping = false;
    xTaskCreatePinnedToCore(muse_advertising_task, "muse_advertising_task", 4096, nullptr, 2, nullptr, 0);
}
inline void muse_stop() {_stopping = true;}

// ---------------- Init ----------------
inline void muse_init() {
    NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
    pAdvertising->setMinInterval(0x06);
    pAdvertising->setMaxInterval(0x12);
}
