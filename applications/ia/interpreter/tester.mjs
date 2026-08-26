#!/usr/bin/env node
/**
 * Jeu d'essai de l'interpréteur déterministe (voir specs/current/fonctionnelles-ia_specs §16).
 *
 * Fait tourner un corpus de phrases contre le moteur RÉEL (le même code que celui utilisé par
 * IaService en production), avec un catalogue de lieux/quois/macros FICTIF (pas connecté à une
 * vraie instance HA) — objectif : vérifier le comportement du moteur de grammaire lui-même de
 * façon reproductible, indépendamment de l'état de la maison. Pour un test contre les VRAIES
 * données HA, passer par le testeur du tableau de bord ia ("Tester une commande") sur une
 * instance en cours d'exécution.
 *
 * USAGE :
 *   cd applications/ia && npm run build   # (une fois, ou après toute modification du moteur)
 *   node interpreter/tester.mjs           # lance tout le corpus
 *   node interpreter/tester.mjs "allume le salon"   # une seule phrase ad hoc
 *
 * Sortie : pour chaque cas, la phrase envoyée puis le résultat — soit la liste des énoncés
 * reconnus (kind action/structured/evenement), soit "UNDEFINED (repli Mistral)". Un résumé
 * compte les cas dont le résultat NE correspond PAS à ce qui était attendu (reconnu vs non
 * reconnu) — ne vérifie pas le détail exact du contenu, juste la reconnaissance elle-même,
 * qui est le point le plus susceptible de régresser en modifiant un gabarit/le moteur.
 */

import { interpretDeterministic, loadVocabulaire, loadGabarits } from '../dist/domain/interpreter/index.js';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const vocab = loadVocabulaire(path.join(HERE, 'vocabulaire.yaml'));
const gabarits = loadGabarits(path.join(HERE, 'gabarits.yaml'));

// ---------------------------------------------------------------------------------------------
// Catalogue fictif — à étoffer si un nouveau cas de test en a besoin (lieux/quois/macros qui
// n'existent pas encore ci-dessous provoqueront un repli Mistral légitime, pas un bug).
// ---------------------------------------------------------------------------------------------
const live = {
  lieux: [
    'Salon', 'Cuisine', 'Chambre', "Chambre d'ami", 'Salle de bain', 'Salle', 'Bureau',
    'Vitrine', 'Plan de travail', 'Garage', 'Jardin', 'Couloir',
    // ⭐ En réel, getLieuCatalog() aplatit AUSSI les lieu_precis en entrées autonomes (pas
    // seulement via les paires composées ci-dessous) — un lieu_precis reste utilisable seul
    // ("le chevet droit", ambigu s'il y en a plusieurs, mais reconnu) : reproduit ici pour que le
    // fictif se comporte comme le vrai catalogue.
    'Chevet gauche', 'Chevet droit', 'Plafonnier'
  ],
  lieuxComposes: [
    { lieuPrecis: 'Chevet gauche', lieu: 'Chambre' },
    { lieuPrecis: 'Chevet droit', lieu: 'Chambre' },
    { lieuPrecis: 'Plafonnier', lieu: 'Salon' }
  ],
  quois: ['lumiere', 'volet', 'radiateur', 'thermostat', 'ventilateur', 'prise', 'chauffage'],
  macros: ['scene cinema', 'bonne nuit', 'je pars'],
  lieuOrigine: undefined
};

// ---------------------------------------------------------------------------------------------
// Corpus de test — { phrase, attendu: true|false } ; true = doit être reconnu par le moteur
// (peu importe le détail exact du résultat), false = doit retomber sur Mistral (undefined).
// ---------------------------------------------------------------------------------------------
const CORPUS = [
  // --- Ordres immédiats on/off (tous les verbes du groupe) --------------------------------
  { section: 'Ordres immédiats — on/off', phrase: 'allume le salon', attendu: true },
  { phrase: 'éteins la lumière du salon', attendu: true },
  { phrase: 'allume la cuisine', attendu: true },
  { phrase: 'ouvre le volet de la chambre', attendu: true },
  { phrase: 'ferme le volet de la chambre', attendu: true },
  { phrase: 'active la prise de la cuisine', attendu: true },
  { phrase: 'désactive la prise du bureau', attendu: true },
  { phrase: 'bascule la lumière du garage', attendu: true },
  { phrase: 'allume', attendu: true, note: 'sans lieu — reconnu quand même, lieux vide (voir §16.6)' },
  { phrase: 'allume tout', attendu: true, note: '"tout" -> lieux=["tous"]' },
  { phrase: 'allume le chevet gauche de la chambre', attendu: true, note: 'lieu composé' },
  { phrase: 'allume le chevet droit', attendu: true, note: 'lieu composé, forme courte (sans "de la chambre")' },

  // --- Ordres avec valeur -------------------------------------------------------------------
  { section: 'Ordres avec valeur', phrase: 'règle le thermostat du salon à vingt', attendu: true },
  { phrase: 'mets le chauffage du bureau à 18', attendu: true },
  { phrase: 'baisse le volet de la cuisine à trente', attendu: true },
  { phrase: 'monte le radiateur de la chambre à vingt deux', attendu: true },

  // --- Planification : délai relatif ---------------------------------------------------------
  { section: 'Planification — délai relatif', phrase: 'dans cinq minutes éteins le salon', attendu: true },
  { phrase: 'dans dix minutes allume la cuisine', attendu: true },
  { phrase: 'attendre trois heures ferme le garage', attendu: true, note: 'attendre+ordre dans la même phrase -> une planification à délai (comme avant)' },
  { phrase: 'attendre trois heures puis ferme le garage', attendu: true, note: '"puis" coupe en 2 phrases ("attendre 3h" seule + "ferme le garage") -> assemblées en UNE séquence execution (wait puis action), pas 2 exécutions indépendantes' },

  // --- "attendre" seul, usage macro (26/08/2026, demande utilisateur) -----------------------
  { section: '"attendre" seul (usage macro)', phrase: 'allume le salon. attendre trois heures. éteins le salon.', attendu: true, note: '3 phrases (points) -> 1 seule commande execution : action, wait, action, dans l\'ordre' },
  { phrase: 'attendre cinq minutes', attendu: true, note: 'un wait seul, sans aucune action -> execution à un seul pas' },
  { phrase: 'dans cinq minutes', attendu: false, note: 'contrairement à "attendre", "dans" seul reste un échec — c\'est un déclencheur, pas un pas de pause' },

  // --- Planification : récurrence quotidienne -------------------------------------------------
  { section: 'Planification — récurrence', phrase: 'tous les jours à midi allume le salon', attendu: true },
  { phrase: 'tous les jours à quatorze heures moins le quart éteins le bureau', attendu: true },
  { phrase: 'tous les lundi et mardi allume la cuisine', attendu: true, note: 'touslesjourssemaine — vérifier RÉSULTAT: days doit être ["mon","tue"] (anglais, pas "lundi"/"mardi" — correctif 26/08/2026, scheduler.ts compare des clés anglaises)' },
  { phrase: 'le week end allume le salon', attendu: true, note: 'leweekend — vérifier RÉSULTAT: days doit être ["sat","sun"]' },
  { phrase: 'tous les jours en semaine à huit heures allume le bureau', attendu: true, note: 'touslesjours+jours_ouvres — vérifier RÉSULTAT: days doit être ["mon","tue","wed","thu","fri"] (correctif capture #jours manquant, 26/08/2026 : ne posait AUCUN filtre avant)' },

  // --- Planification : fenêtre "entre X et Y" (26/08/2026) -----------------------------------
  { section: 'Planification — fenêtre (entre)', phrase: 'entre quatorze heures et dix huit heures allume le salon', attendu: true, note: 'trigger.type=window, from/to' },
  { phrase: 'tous les jours jusqu à midi allume le salon', attendu: true, note: '"jusqu à" fusionné dans le gabarit "a"' },

  // --- Planification : lever/coucher de soleil (26/08/2026, suite — plus hors périmètre) -----
  { section: 'Planification — lever/coucher de soleil', phrase: 'au lever du soleil allume la cuisine', attendu: true, note: 'sunevent bare, sans décalage — vérifier RÉSULTAT: offset_seconds:0' },
  { phrase: 'tous les jours au coucher du soleil allume le salon', attendu: true, note: 'combiné avec touslesjours — plus hors périmètre depuis le trigger.type=sun (suncalc côté planificateur)' },
  { phrase: 'une heure après le coucher du soleil ferme le volet', attendu: true, note: 'offset positif — vérifier RÉSULTAT: offset_seconds:3600' },
  { phrase: 'trente minutes avant le lever du soleil ouvre le volet', attendu: true, note: 'offset négatif — vérifier RÉSULTAT: offset_seconds:-1800' },
  { phrase: 'le week end une heure après le coucher du soleil ferme le volet', attendu: true, note: 'cas exact de la demande utilisateur (26/08/2026) — combine filtre de jours ET décalage solaire ; vérifier RÉSULTAT: days:["sat","sun"], sun_event:"coucher", offset_seconds:3600' },

  // --- Interrogation "donne" (26/08/2026) -----------------------------------------------------
  { section: 'Interrogation (donne)', phrase: 'donne moi la lumière du salon', attendu: true, note: 'routé vers la résolution d\'entités, pas un portage de donnemoi.js' },
  { phrase: 'donne moi l état de la cuisine', attendu: true },
  { phrase: 'montre moi le volet de la chambre', attendu: true, note: 'autre forme de surface du même verbe' },

  // --- Exclusion de lieux "sauf" (26/08/2026, trouvé dans le fichier de conflit legacy) -------
  { section: 'Exclusion (sauf)', phrase: 'allume tout sauf le garage', attendu: true, note: 'lieux = tous les lieux connus moins le garage' },
  { phrase: 'allume le salon et la cuisine sauf la cuisine', attendu: true, note: 'exclusion sur une liste explicite (cas limite, pas juste "tous")' },
  { phrase: 'allume le salon sauf le salon', attendu: false, note: 'exclusion qui vide une liste explicite (contradiction) -> repli Mistral, pas "toute la maison" (bug réel trouvé en test live le 26/08)' },

  // --- Nombres en lettres (vérifie numbers.ts en conditions réelles) -------------------------
  { section: 'Nombres en lettres', phrase: 'règle le thermostat du salon à quatre vingt treize', attendu: true },
  { phrase: 'dans soixante seize minutes allume la cuisine', attendu: true },

  // --- Plusieurs commandes dans une seule phrase ----------------------------------------------
  { section: 'Plusieurs commandes', phrase: 'allume le salon puis éteins la cuisine', attendu: true, note: 'séparateur explicite "puis"' },
  { phrase: 'allume le salon; éteins la cuisine', attendu: true, note: 'séparateur ";"' },
  { phrase: 'allume le salon ensuite éteins la cuisine', attendu: true, note: 'séparateur "ensuite"' },
  { phrase: 'allume le salon éteins la cuisine', attendu: true, note: 'SANS séparateur — détection par ancrage de verbe' },
  { phrase: 'allume le salon et la cuisine', attendu: true, note: '"et" NON séparateur ici : un seul ordre, deux lieux' },

  // --- Gabarit événementiel si_alors -----------------------------------------------------------
  { section: 'Événementiel (si_alors)', phrase: "si la vitrine s'allume alors allume le plan de travail", attendu: true },
  { phrase: 'si la lumière du salon s\'éteint, ferme le volet de la chambre', attendu: true, note: 'connecteur virgule au lieu de "alors"' },

  // --- Macros --------------------------------------------------------------------------------
  { section: 'Macros', phrase: 'scene cinema', attendu: true },
  { phrase: 'bonne nuit', attendu: true },

  // --- Régression : bug de découpage de phrases (corrigé cette session) ----------------------
  { section: 'Régression — découpage de phrases', phrase: 'règle le chauffage du salon à vingt. allume la cuisine', attendu: true, note: 'phrase se terminant par un nombre entier AVANT le point — bug legacy corrigé (sans le correctif, jamais coupée de la suivante)' },
  { phrase: 'règle le thermostat du salon à 20.5', attendu: true, note: 'décimal préservé (ne doit pas être coupé en deux)' },
  { phrase: 'allume le salon depuis la cuisine', attendu: false, note: '"depuis" ne doit PAS être confondu avec le séparateur "puis" (faux positif legacy)' },

  // --- Cas qui NE doivent PAS être reconnus (repli Mistral attendu) --------------------------
  { section: 'Repli Mistral attendu', phrase: 'quelle heure est-il à Paris', attendu: false },
  { phrase: 'la maison est jolie aujourd\'hui', attendu: false },
  { phrase: 'quand la porte du garage reste ouverte plus de dix minutes envoie une alerte', attendu: false, note: 'condition sur seuil, hors périmètre actuel' }
];

// ---------------------------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------------------------
function run(phrase) {
  return interpretDeterministic(phrase, vocab, gabarits, live);
}

const singlePhrase = process.argv[2];
const cases = singlePhrase ? [{ phrase: singlePhrase, attendu: undefined }] : CORPUS;

let lastSection;
let ok = 0;
let ko = 0;

for (const c of cases) {
  if (c.section && c.section !== lastSection) {
    lastSection = c.section;
    console.log(`\n\x1b[1m=== ${lastSection} ===\x1b[0m`);
  }
  const result = run(c.phrase);
  const reconnu = result !== undefined;
  const marqueur = c.attendu === undefined ? '' : reconnu === c.attendu ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ INATTENDU\x1b[0m';
  if (c.attendu !== undefined) { if (reconnu === c.attendu) ok++; else ko++; }

  console.log(`\n${marqueur} ENVOI    : ${c.phrase}`);
  if (c.note) console.log(`  (${c.note})`);
  console.log(`  RÉSULTAT : ${reconnu ? JSON.stringify(result) : 'UNDEFINED (repli Mistral)'}`);
}

if (!singlePhrase) {
  console.log(`\n\x1b[1m--- Résumé : ${ok} conforme(s), ${ko} inattendu(s) sur ${ok + ko} cas ---\x1b[0m`);
  if (ko > 0) process.exitCode = 1;
}
