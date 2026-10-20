// Composant ESPHome « magic_switch » (Sonoff Basic R4) — dérivé de Tasmota xdrv_91_magic_switch.ino, © 2021 Barbudor, GPL v3.
//
// Principe : sur le R4, l'entrée GPIO5 reçoit en permanence de brèves impulsions (zero-cross du secteur, ~650 µs toutes
// les 10 ms). Actionner l'interrupteur mural provoque une impulsion PLUS LONGUE (>= 4000 µs) : c'est un appui.
// Une impulsion retenue verrouille la détection (les fronts suivants sont ignorés) jusqu'à la fin d'une fenêtre de masquage.
#pragma once

#include "esphome/core/automation.h"
#include "esphome/core/component.h"
#include "esphome/core/hal.h"

namespace esphome {
namespace magic_switch {

class MagicSwitch : public Component {
 public:
  void setup() override;
  void loop() override;
  float get_setup_priority() const override;
  void dump_config() override;

  void set_pin(InternalGPIOPin *pin) { this->pin_ = pin; }
  void set_min_pulse(uint32_t us) { this->min_pulse_ = us; }
  void set_masking_window(uint32_t ms) { this->masking_window_ms_ = ms; }
  Trigger<> *get_switch_trigger() const { return switch_trigger_; }

 protected:
  static void IRAM_ATTR edge_intr(MagicSwitch *self);

  InternalGPIOPin *pin_{nullptr};
  ISRInternalGPIOPin isr_pin_;
  uint32_t min_pulse_{4000};
  uint32_t masking_window_ms_{250};
  Trigger<> *switch_trigger_ = new Trigger<>();

  volatile uint32_t start_time_{0};  // horodatage du front montant (jamais 0 si valide)
  volatile uint32_t pulse_len_{0};   // largeur retenue, non nulle tant qu'elle n'est pas traitée (= fenêtre de masquage)
  uint32_t masking_start_{0};
  bool masking_{false};
};

}  // namespace magic_switch
}  // namespace esphome
