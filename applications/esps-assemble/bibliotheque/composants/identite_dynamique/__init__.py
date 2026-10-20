# Composant ESPHome « identite_dynamique » — taxonomie de l'appareil (nom au format de la convention) modifiable SANS reflashage.
# Les cinq parties du nom sont mémorisées dans la flash de l'ESP. Si rien n'est mémorisé, elles prennent les valeurs du code (les
# paramètres de l'élément) ; ensuite tout part de ce qui est mémorisé. Voir fiche et spécification conception-esphome-assembleur §3.12.
# Licence : MIT (code propre au projet dimotic-ha).
import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.const import CONF_ID

CODEOWNERS = []

identite_ns = cg.esphome_ns.namespace("identite_dynamique")
IdentiteDynamique = identite_ns.class_("IdentiteDynamique", cg.Component)

CONF_QUOI = "quoi"
CONF_LIEU_PRECIS = "lieu_precis"
CONF_LIEU = "lieu"
CONF_PERE = "pere"
CONF_GRAND_PERE = "grand_pere"

CONFIG_SCHEMA = cv.COMPONENT_SCHEMA.extend(
    {
        cv.GenerateID(): cv.declare_id(IdentiteDynamique),
        cv.Required(CONF_QUOI): cv.string,
        cv.Optional(CONF_LIEU_PRECIS, default=""): cv.string,
        cv.Required(CONF_LIEU): cv.string,
        cv.Optional(CONF_PERE, default=""): cv.string,
        cv.Optional(CONF_GRAND_PERE, default=""): cv.string,
    }
)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    for i, cle in enumerate([CONF_QUOI, CONF_LIEU_PRECIS, CONF_LIEU, CONF_PERE, CONF_GRAND_PERE]):
        cg.add(var.set_defaut(i, config[cle]))
