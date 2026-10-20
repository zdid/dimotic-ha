// Composant ESPHome « magic_switch » (Sonoff Basic R4) — dérivé de Tasmota xdrv_91_magic_switch.ino, © 2021 Barbudor, GPL v3.
#include "magic_switch.h"
#include "esphome/core/log.h"

namespace esphome {
namespace magic_switch {

static const char *const TAG = "magic_switch";

void MagicSwitch::setup() {
  this->pin_->pin_mode(gpio::FLAG_INPUT | gpio::FLAG_PULLUP);
  this->pin_->setup();
  this->isr_pin_ = this->pin_->to_isr();
  this->pin_->attach_interrupt(MagicSwitch::edge_intr, this, gpio::INTERRUPT_ANY_EDGE);
}

// Niveau interruption : équivalent de MagicSwitch_intr de Tasmota.
void IRAM_ATTR HOT MagicSwitch::edge_intr(MagicSwitch *self) {
  uint32_t now = micros();
  bool pin_state = self->isr_pin_.digital_read();
  if (self->pulse_len_) {
    return;  // impulsion précédente pas encore traitée : on ignore le front (masquage)
  } else if (pin_state) {
    self->start_time_ = now | 1;  // front montant ; « | 1 » évite la valeur 0
  } else if (self->start_time_) {
    uint32_t pulse_len = now - self->start_time_;
    self->start_time_ = 0;  // un front montant manqué ne doit pas déclencher à tort
    if (pulse_len >= self->min_pulse_)
      self->pulse_len_ = pulse_len;
  }
}

// Équivalent de MagicSwitchLoop de Tasmota (appelé ici à chaque tour de boucle d'ESPHome, pas toutes les 50 ms).
void MagicSwitch::loop() {
  if (this->masking_) {
    if (millis() - this->masking_start_ >= this->masking_window_ms_) {
      this->masking_ = false;
      this->pulse_len_ = 0;  // fin de la fenêtre : on réarme la détection
      ESP_LOGV(TAG, "fin de la fenêtre de masquage");
    }
  } else if (this->pulse_len_) {
    ESP_LOGD(TAG, "appui détecté (impulsion de %u us), masquage %u ms", (unsigned) this->pulse_len_,
             (unsigned) this->masking_window_ms_);
    this->masking_ = true;
    this->masking_start_ = millis();
    this->switch_trigger_->trigger();
  }
}

float MagicSwitch::get_setup_priority() const { return setup_priority::DATA; }

void MagicSwitch::dump_config() {
  ESP_LOGCONFIG(TAG, "Magic Switch (Sonoff Basic R4) :");
  LOG_PIN("  Broche : ", this->pin_);
  ESP_LOGCONFIG(TAG, "  Impulsion minimale : %u us", (unsigned) this->min_pulse_);
  ESP_LOGCONFIG(TAG, "  Fenêtre de masquage : %u ms", (unsigned) this->masking_window_ms_);
}

}  // namespace magic_switch
}  // namespace esphome
