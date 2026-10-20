// Composant ESPHome « identite_dynamique » : nom d'appareil au format de la convention, modifiable sans reflashage.
//
// Règle : les cinq parties (quoi, lieu précis, lieu, père, grand-père) sont mémorisées dans la flash. Au démarrage, si rien n'est
// mémorisé, elles sont créées à partir des valeurs du code ; le nom publié est toujours composé à partir de ce qui est mémorisé.
// Le nom est appliqué au `friendly_name` de l'application : le module MQTT d'ESPHome le relit à CHAQUE envoi de la découverte
// (device.name), que NOMMAGE lit pour calculer la taxonomie. Les identifiants des entités (sujets, unique_id) sont des constantes de
// compilation : changer le nom ne crée pas de nouvelle entité.
#pragma once

#include <string>
#include "esphome/core/component.h"
#include "esphome/core/preferences.h"

namespace esphome {
namespace identite_dynamique {

static const uint8_t NB_PARTIES = 5;
static const uint8_t TAILLE_PARTIE = 48;  // 47 caractères utiles (UTF-8) + fin de chaîne

class IdentiteDynamique : public Component {
 public:
  void setup() override;
  float get_setup_priority() const override { return setup_priority::DATA; }
  void dump_config() override;

  void set_defaut(uint8_t i, const std::string &v) { if (i < NB_PARTIES) this->defauts_[i] = v; }
  /** Partie mémorisée (0 quoi, 1 lieu précis, 2 lieu, 3 père, 4 grand-père). */
  const std::string &get_part(uint8_t i) const { return this->parties_[i < NB_PARTIES ? i : 0]; }
  /** Change une partie. Retourne true UNIQUEMENT si la valeur a été acceptée ET a changé (mémorisée, nom appliqué) ; false si le nom
   *  résultant ne suit pas la convention (rien de modifié) ou si la valeur est identique. */
  bool set_part(uint8_t i, const std::string &valeur);
  /** Nom au format quoi---[précis--]lieu[--père[--grand-père]] à partir des parties mémorisées. */
  std::string nom() const;
  /** Valide un jeu de cinq parties (QUOI et lieu non vides, grand-père seulement avec un père, pas de « -- », « / », « # », « + »). */
  static bool valide(const std::string p[NB_PARTIES]);

 protected:
  struct Stocke {
    uint32_t magie;
    char parties[NB_PARTIES][TAILLE_PARTIE];
  };
  static const uint32_t MAGIE = 0x49444E31;  // « IDN1 »

  void appliquer_();
  void sauver_();

  std::string defauts_[NB_PARTIES];
  std::string parties_[NB_PARTIES];
  ESPPreferenceObject pref_;
};

}  // namespace identite_dynamique
}  // namespace esphome
