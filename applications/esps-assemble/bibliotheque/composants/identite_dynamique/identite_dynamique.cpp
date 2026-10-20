#include "identite_dynamique.h"
#include <cstring>
#include "esphome/core/application.h"
#include "esphome/core/helpers.h"
#include "esphome/core/log.h"

namespace esphome {
namespace identite_dynamique {

static const char *const TAG = "identite_dynamique";

static std::string rogner(const std::string &s) {
  size_t a = s.find_first_not_of(" \t"), b = s.find_last_not_of(" \t");
  return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}

static bool partie_ok(const std::string &s) {
  if (s.size() >= TAILLE_PARTIE) return false;
  if (s.find("--") != std::string::npos) return false;
  if (s.find_first_of("\"\\/#+") != std::string::npos) return false;
  if (!s.empty() && (s.front() == '-' || s.back() == '-')) return false;
  return true;
}

bool IdentiteDynamique::valide(const std::string p[NB_PARTIES]) {
  for (uint8_t i = 0; i < NB_PARTIES; i++)
    if (!partie_ok(p[i])) return false;
  if (p[0].empty() || p[2].empty()) return false;  // QUOI et lieu obligatoires
  if (!p[4].empty() && p[3].empty()) return false;  // grand-père seulement avec un père
  return true;
}

std::string IdentiteDynamique::nom() const {
  std::string n = this->parties_[0] + "---";
  bool premier = true;
  for (uint8_t i = 1; i < NB_PARTIES; i++) {
    if (this->parties_[i].empty()) continue;
    if (!premier) n += "--";
    n += this->parties_[i];
    premier = false;
  }
  return n;
}

void IdentiteDynamique::setup() {
  this->pref_ = global_preferences->make_preference<Stocke>(fnv1_hash("identite_dynamique"));
  Stocke s{};
  bool charge = this->pref_.load(&s) && s.magie == MAGIE;
  std::string lues[NB_PARTIES];
  if (charge) {
    for (uint8_t i = 0; i < NB_PARTIES; i++) {
      s.parties[i][TAILLE_PARTIE - 1] = '\0';
      lues[i] = s.parties[i];
    }
  }
  if (charge && valide(lues)) {
    for (uint8_t i = 0; i < NB_PARTIES; i++) this->parties_[i] = lues[i];
    ESP_LOGI(TAG, "taxonomie lue dans la flash : %s", this->nom().c_str());
  } else {
    // Rien de mémorisé (ou valeur illisible) : la surcharge est créée à partir du code.
    for (uint8_t i = 0; i < NB_PARTIES; i++) this->parties_[i] = rogner(this->defauts_[i]);
    this->sauver_();
    ESP_LOGI(TAG, "taxonomie créée à partir du code : %s", this->nom().c_str());
  }
  this->appliquer_();
}

bool IdentiteDynamique::set_part(uint8_t i, const std::string &valeur) {
  if (i >= NB_PARTIES) return false;
  std::string essai[NB_PARTIES];
  for (uint8_t k = 0; k < NB_PARTIES; k++) essai[k] = this->parties_[k];
  essai[i] = rogner(valeur);
  if (!valide(essai)) {
    ESP_LOGW(TAG, "partie %u refusée (« %s ») : le nom ne suivrait pas la convention", i, valeur.c_str());
    return false;
  }
  if (essai[i] == this->parties_[i]) return false;  // inchangée : rien à faire
  this->parties_[i] = essai[i];
  this->sauver_();
  this->appliquer_();
  ESP_LOGI(TAG, "nouvelle taxonomie : %s", this->nom().c_str());
  return true;
}

void IdentiteDynamique::sauver_() {
  Stocke s{};
  s.magie = MAGIE;
  for (uint8_t i = 0; i < NB_PARTIES; i++) strncpy(s.parties[i], this->parties_[i].c_str(), TAILLE_PARTIE - 1);
  this->pref_.save(&s);
  global_preferences->sync();
}

void IdentiteDynamique::appliquer_() {
  // `App.get_friendly_name()` renvoie une référence constante vers le membre de l'application : le module MQTT la relit à chaque
  // envoi de découverte. On la remplace par le nom composé à partir des parties mémorisées.
  const_cast<std::string &>(App.get_friendly_name()) = this->nom();
}

void IdentiteDynamique::dump_config() {
  ESP_LOGCONFIG(TAG, "Identité dynamique (taxonomie) :");
  ESP_LOGCONFIG(TAG, "  Nom : %s", this->nom().c_str());
}

}  // namespace identite_dynamique
}  // namespace esphome
