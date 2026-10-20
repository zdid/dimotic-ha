# Composant ESPHome « magic_switch » — Sonoff Basic R4 (ESP32-C3).
# Dérivé de Tasmota (tasmota/tasmota_xdrv_driver/xdrv_91_magic_switch.ino, © 2021 Barbudor, GPL v3) : même algorithme.
# Licence : GNU General Public License v3 ou ultérieure — voir LICENCE-GPL3.txt à côté.
import esphome.codegen as cg
import esphome.config_validation as cv
from esphome import automation, pins
from esphome.const import CONF_ID, CONF_PIN

CODEOWNERS = []

magic_switch_ns = cg.esphome_ns.namespace("magic_switch")
MagicSwitch = magic_switch_ns.class_("MagicSwitch", cg.Component)

CONF_ON_SWITCH = "on_switch"
CONF_MIN_PULSE = "min_pulse"
CONF_MASKING_WINDOW = "masking_window"

CONFIG_SCHEMA = cv.COMPONENT_SCHEMA.extend(
    {
        cv.GenerateID(): cv.declare_id(MagicSwitch),
        # Entrée « zero-cross » du R4 : GPIO5. Pull-up activé par défaut, comme le mode 0 de Tasmota.
        cv.Required(CONF_PIN): pins.internal_gpio_input_pin_schema,
        # Largeur minimale d'une impulsion haute pour compter comme un appui (Tasmota : 4000 µs, plage 1000..500000).
        cv.Optional(CONF_MIN_PULSE, default="4000us"): cv.All(
            cv.positive_time_period_microseconds,
            cv.Range(min=cv.TimePeriod(microseconds=1000), max=cv.TimePeriod(microseconds=500000)),
        ),
        # Après un appui, les impulsions suivantes sont ignorées pendant ce délai (Tasmota : 5 x 50 ms = 250 ms).
        cv.Optional(CONF_MASKING_WINDOW, default="250ms"): cv.positive_time_period_milliseconds,
        cv.Optional(CONF_ON_SWITCH): automation.validate_automation(single=True),
    }
)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    pin = await cg.gpio_pin_expression(config[CONF_PIN])
    cg.add(var.set_pin(pin))
    cg.add(var.set_min_pulse(config[CONF_MIN_PULSE]))
    cg.add(var.set_masking_window(config[CONF_MASKING_WINDOW]))
    if conf := config.get(CONF_ON_SWITCH):
        await automation.build_automation(var.get_switch_trigger(), [], conf)
