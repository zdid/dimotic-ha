/**
 * Outils exposés à Claude Code par le serveur MCP (specs ia v1.19 §19) :
 *  - les trois outils déjà donnés à Mistral (tools.ts) — mêmes schémas, même ToolExecutor ;
 *  - trois outils de LECTURE propres à Claude Code, qui n'agissent jamais sur la maison :
 *      obtenir_details            attributs réels + classement quoi/lieu des entités
 *      diagnostiquer_resolution   « pourquoi cette entité (ne) ressort (pas) ? »
 *      tester_phrase              simulation d'une phrase dans le pipeline d'ia, sans rien exécuter
 */

import type { HaLecture } from './HaLectureDirecte';
import type { McpToolDef } from './McpHttpServer';
import { IA_TOOLS } from './tools';
import type { ToolExecutor } from './ToolExecutor';
import type { PlannerReader, PlannerSection } from './PlannerReader';
import type { HaAutomationClient } from './HaAutomationClient';
import type { PilotesClient } from './PilotesClient';
import type { HaEntiteRenamer } from './HaEntiteRenamer';
import type { HaAideClient } from './HaAideClient';
import type { HaTableauClient } from './HaTableauClient';
import type { HaPieceClient } from './HaPieceClient';
import type { HaAuditNomsClient } from './HaAuditNomsClient';
import type { HaAppareilRenamer } from './HaAppareilRenamer';
import type { HaEtiquetteClient } from './HaEtiquetteClient';
import type { HaReferencesClient } from './HaReferencesClient';

const CONFIRM_PROP = { type: 'boolean', description: 'false/absent = APERÇU seulement (rien n\'est modifié). true = exécute, À N\'UTILISER QU\'APRÈS l\'accord explicite de l\'utilisateur sur l\'aperçu.' };

/** Outils d'écriture des automatisations HA (niveau 2) : aperçu d'abord, sauvegarde avant remplacement. */
export const HA_AUTOMATION_TOOLS: McpToolDef[] = [
  {
    name: 'lire_automatisations_ha',
    description: 'Lit les automatisations de Home Assistant (lecture seule). Sans paramètre : liste (id, nom, état, dernière exécution). Avec id : définition complète. Avec sauvegardes=true : sauvegardes disponibles (et leur contenu si fichier est donné).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Identifiant de configuration de l\'automatisation (champ id, pas l\'entity_id)' },
        sauvegardes: { type: 'boolean', description: 'Lister les sauvegardes faites avant remplacement/suppression (filtrées par id si donné)' },
        fichier: { type: 'string', description: 'Nom d\'un fichier de sauvegarde à lire (avec sauvegardes=true)' }
      }
    }
  },
  {
    name: 'deposer_automatisation',
    description: 'DÉPOSE (crée ou remplace) une automatisation dans Home Assistant, puis recharge les automatisations. Sans confirme:true, renvoie seulement un aperçu et ne modifie RIEN. L\'existant est sauvegardé avant remplacement. Respecte l\'anti-boucle : from/to explicites, mode single, condition de garde.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Identifiant stable de l\'automatisation (lettres, chiffres, _ et -)' },
        definition: { type: 'object', description: 'Définition JSON de l\'automatisation, comme son YAML : alias, description, mode, trigger(s), condition(s), action(s)' },
        confirme: CONFIRM_PROP
      },
      required: ['id', 'definition']
    }
  },
  {
    name: 'supprimer_automatisation',
    description: 'SUPPRIME une automatisation de Home Assistant. Sans confirme:true, renvoie seulement un aperçu. La définition est sauvegardée avant suppression.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Identifiant de configuration' }, confirme: CONFIRM_PROP }, required: ['id'] }
  }
];

/** Renommage d'entité HA (registre des entités) : aperçu d'abord, confirmation ensuite. */
export const HA_ENTITE_TOOLS: McpToolDef[] = [
  {
    name: 'renommer_entite_ha',
    description: 'RENOMME une entité de Home Assistant (nouvel entity_id et/ou nom affiché) via le registre des entités. Sans confirme:true, renvoie seulement un aperçu (état actuel, identifiant libre ou déjà pris, automatisations qui citent l\'ancien identifiant) et ne modifie RIEN. HA ne réécrit pas les références : à corriger ensuite. Le domaine ne peut pas changer.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'entity_id actuel (ex. sensor.temperature_salon)' },
        nouvel_entity_id: { type: 'string', description: 'Nouvel entity_id (même domaine). Absent = inchangé' },
        nom: { type: 'string', description: 'Nouveau nom affiché. Chaîne vide = revenir au nom d\'origine. Absent = inchangé' },
        confirme: CONFIRM_PROP
      },
      required: ['entity_id']
    }
  }
];

/** Aides HA (minuteries, interrupteurs virtuels…) : création / liste / suppression, aperçu d'abord. */
export const HA_AIDE_TOOLS: McpToolDef[] = [
  {
    name: 'creer_aide_ha',
    description: 'CRÉE, LISTE ou SUPPRIME une aide Home Assistant (timer, input_boolean, input_number, input_text, input_select, input_datetime, counter). action=lister (lecture), creer (nom + options, ex. timer : {"duration":"24:00:00","restore":true}), supprimer (id = identifiant sans le domaine). Sans confirme:true, créer et supprimer renvoient seulement un APERÇU (entity_id prévu, collision éventuelle) et ne modifient RIEN. Une aide supprimée est sauvegardée avant.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['lister', 'creer', 'supprimer'], description: 'Défaut : creer' },
        domaine: { type: 'string', enum: ['timer', 'input_boolean', 'input_number', 'input_text', 'input_select', 'input_datetime', 'counter'] },
        nom: { type: 'string', description: 'Nom affiché (creer) ; l\'entity_id en est tiré (ex. « Minuterie salle tele » → timer.minuterie_salle_tele)' },
        options: { type: 'object', description: 'Réglages propres au domaine (creer), ex. timer : duration, restore ; input_number : min, max, step' },
        id: { type: 'string', description: 'Identifiant de l\'aide sans le domaine (supprimer)' },
        confirme: CONFIRM_PROP
      },
      required: ['domaine']
    }
  }
];

/** Scripts de HA : lecture, dépôt (aperçu puis confirmation, sauvegarde avant remplacement), suppression. */
export const HA_SCRIPT_TOOLS: McpToolDef[] = [
  {
    name: 'lire_scripts_ha',
    description: 'Lit les scripts de Home Assistant (lecture seule). Sans paramètre : liste (id, nom, état). Avec id : définition complète. Avec sauvegardes=true : sauvegardes faites avant remplacement/suppression (et leur contenu si fichier est donné).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Identifiant du script (script.<id>)' }, sauvegardes: { type: 'boolean' }, fichier: { type: 'string', description: 'Nom d\'un fichier de sauvegarde à lire (avec sauvegardes=true)' } } }
  },
  {
    name: 'deposer_script',
    description: 'DÉPOSE (crée ou remplace) un script dans Home Assistant, puis recharge les scripts. Sans confirme:true, renvoie seulement un aperçu et ne modifie RIEN. L\'existant est sauvegardé avant remplacement. Définition JSON équivalente au YAML : alias (nom) et description OBLIGATOIRES, fields (paramètres, chacun avec name et description), mode, sequence (liste d\'actions). Appel depuis une automatisation : action script.<id> avec data = les champs.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Identifiant stable du script (lettres, chiffres, _ et -)' },
        definition: { type: 'object', description: 'Définition JSON du script : alias (nom) et description obligatoires, mode, fields, sequence' },
        confirme: CONFIRM_PROP
      },
      required: ['id', 'definition']
    }
  },
  {
    name: 'supprimer_script',
    description: 'SUPPRIME un script de Home Assistant. Sans confirme:true, renvoie seulement un aperçu. La définition est sauvegardée avant suppression. Vérifier avant qu\'aucune automatisation ne l\'appelle (verifier_entity_ids).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, confirme: CONFIRM_PROP }, required: ['id'] }
  }
];

/** Tableaux de bord (graphes, cartes) et configuration Énergie de HA : lecture, puis dépôt avec aperçu et sauvegarde. */
export const HA_TABLEAU_TOOLS: McpToolDef[] = [
  {
    name: 'lire_tableaux_de_bord',
    description: 'Lit les tableaux de bord de Home Assistant (lecture seule). Sans paramètre : liste des tableaux. Avec url_path : leur configuration complète (vues et cartes, y compris les graphes) ; url_path vide ("") = le tableau par défaut. À utiliser AVANT de modifier un tableau.',
    inputSchema: { type: 'object', properties: { url_path: { type: 'string', description: 'Identifiant du tableau (ex. energie-direct) ; "" = tableau par défaut' } } }
  },
  {
    name: 'deposer_tableau_de_bord',
    description: 'CRÉE ou REMPLACE un tableau de bord de Home Assistant (vues et cartes : graphes history-graph / statistics-graph, jauges, énergie…). Sans confirme:true, renvoie seulement un aperçu (vues avant/après) et ne modifie RIEN. L\'existant est sauvegardé avant remplacement. La config est REMPLACÉE ENTIÈRE : partir de lire_tableaux_de_bord, modifier, renvoyer le tout. Pour un tableau nouveau, donner creer {titre, icone} et un url_path avec un tiret.',
    inputSchema: {
      type: 'object',
      properties: {
        url_path: { type: 'string', description: 'Identifiant du tableau (minuscules, chiffres, au moins un tiret) ; "" = tableau par défaut' },
        config: { type: 'object', description: 'Configuration Lovelace complète : { views: [ { title, path, cards: [...] } ] }' },
        creer: { type: 'object', description: 'Si le tableau n\'existe pas : { titre, icone } (ex. icone mdi:chart-line)' },
        confirme: CONFIRM_PROP
      },
      required: ['url_path', 'config']
    }
  },
  {
    name: 'lire_energie',
    description: 'Lit la configuration du tableau Énergie de Home Assistant (sources, consommateurs). Lecture seule.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'deposer_energie',
    description: 'MODIFIE la configuration du tableau Énergie de HA (clés permises : energy_sources, device_consumption, device_consumption_water). Chaque clé donnée est remplacée ENTIÈRE. Sans confirme:true, aperçu seulement. L\'existant est sauvegardé avant.',
    inputSchema: { type: 'object', properties: { prefs: { type: 'object', description: 'Ex. { device_consumption: [ { stat_consumption: "sensor.x_energie" } ] }' }, confirme: CONFIRM_PROP }, required: ['prefs'] }
  }
];

/** Vérification des références d'entités (lecture seule). */
export const HA_REFERENCES_TOOLS: McpToolDef[] = [
  {
    name: 'verifier_entity_ids',
    description: 'LECTURE SEULE. Parcourt les automatisations, scripts, scènes, tableaux de bord, la configuration Énergie et les plans de Home Assistant et liste les entity_id cités qui N\'EXISTENT PLUS (après un renommage, par exemple), avec les entités existantes les plus proches en suggestion. À utiliser avant de corriger : confirmer chaque suggestion avec l\'utilisateur.',
    inputSchema: { type: 'object', properties: { portee: { type: 'array', items: { type: 'string', enum: ['automatisations', 'scripts', 'scenes', 'tableaux', 'energie', 'plans'] }, description: 'Sources à examiner (défaut : toutes)' } } }
  }
];

/** Pièces (areas) de HA : lecture, affectation, renommage, suppression des pièces vides. */
export const HA_PIECE_TOOLS: McpToolDef[] = [
  {
    name: 'lire_pieces_ha',
    description: 'Liste les pièces (areas) de Home Assistant avec, pour chacune, le nombre d\'appareils et d\'entités affectés et si elle est VIDE. Lecture seule.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'affecter_piece_ha',
    description: 'AFFECTE des entités (entity_id) et/ou des appareils (device_id) à une pièce de HA ; la pièce est créée si elle n\'existe pas (première lettre en majuscule). piece="" retire l\'affectation directe. Sans confirme:true, aperçu seulement (avant/après). Attention : nommage recalcule les pièces depuis le nom, une affectation contraire au nom peut être écrasée.',
    inputSchema: {
      type: 'object',
      properties: {
        entites: { type: 'array', items: { type: 'string' }, description: 'entity_id à affecter' },
        appareils: { type: 'array', items: { type: 'string' }, description: 'device_id à affecter' },
        piece: { type: 'string', description: 'Nom (ou area_id) de la pièce ; "" = retirer' },
        confirme: CONFIRM_PROP
      },
      required: ['piece']
    }
  },
  {
    name: 'renommer_piece_ha',
    description: 'RENOMME une pièce de HA (première lettre en majuscule ; l\'area_id ne change pas). Sans confirme:true, aperçu seulement (contenu, automatisations qui la citent). Refuse un nom déjà pris. Attention : nommage recrée l\'ancienne pièce tant que des noms d\'appareils portent l\'ancien lieu.',
    inputSchema: { type: 'object', properties: { piece: { type: 'string', description: 'Nom ou area_id actuel' }, nouveau_nom: { type: 'string' }, confirme: CONFIRM_PROP }, required: ['piece', 'nouveau_nom'] }
  },
  {
    name: 'supprimer_pieces_vides_ha',
    description: 'SUPPRIME des pièces VIDES de HA (aucun appareil ni entité). Sans « pieces » : toutes les pièces vides. Sans confirme:true, aperçu seulement (liste, automatisations qui les citent). Une pièce non vide est refusée. La définition supprimée est sauvegardée avant.',
    inputSchema: { type: 'object', properties: { pieces: { type: 'array', items: { type: 'string' }, description: 'Noms ou area_id (facultatif)' }, confirme: CONFIRM_PROP } }
  }
];

/** Audit des noms de HA (lecture seule). */
export const HA_AUDIT_TOOLS: McpToolDef[] = [
  {
    name: 'auditer_noms_ha',
    description: 'LECTURE SEULE. Audite les noms de Home Assistant : (1) `horsConvention` = appareils dont le nom ne suit pas la convention quoi---[précis--]lieu[--père[--grand-père]] (donc sans taxonomie ni pièce déduite du nom), avec leur pièce actuelle, leurs plateformes et une suggestion de nom À AFFINER avec l\'utilisateur ; (2) `identifiantsDecales` = entités dont l\'entity_id commence par le nom d\'une pièce qui n\'est plus leur pièce (appareil déplacé), avec l\'identifiant attendu aujourd\'hui et s\'il est déjà pris. Ne modifie rien : pour corriger un identifiant, verifier_entity_ids (références) PUIS renommer_entite_ha avec confirme.',
    inputSchema: {
      type: 'object',
      properties: {
        portee: { type: 'string', enum: ['appareils', 'identifiants', 'tous'], description: 'Constat demandé (défaut : tous)' },
        limite: { type: 'integer', description: 'Lignes par liste (défaut 40, 200 au plus)' }
      }
    }
  },
  {
    name: 'renommer_appareil_ha',
    description: 'RENOMME un APPAREIL de Home Assistant (name_by_user) avec un nom au format quoi---[précis--]lieu[--père[--grand-père]] (format contrôlé ; refusé pour un appareil déjà classé par NOMMAGE). device_id vient de auditer_noms_ha. Sans confirme:true, aperçu seulement et ne modifie RIEN ; la commande pour annuler est donnée. Les entity_id existants ne changent pas. Toujours faire valider le nom par l\'utilisateur avant confirme.',
    inputSchema: {
      type: 'object',
      properties: {
        device_id: { type: 'string', description: 'Identifiant de l\'appareil (auditer_noms_ha)' },
        nom: { type: 'string', description: 'Nouveau nom, ex. « climatiseur---chambre d\'ami--étage--maison ». Chaîne vide interdite' },
        confirme: CONFIRM_PROP
      },
      required: ['device_id', 'nom']
    }
  }
];

/** Étiquettes de HA : rangement des automatisations/scripts dans le tableau « Automatisations ». */
export const HA_ETIQUETTE_TOOLS: McpToolDef[] = [
  {
    name: 'lire_etiquettes_ha',
    description: 'LECTURE SEULE. Liste les étiquettes (labels) de Home Assistant avec les automatisations/scripts qui les portent, et les automatisations/scripts SANS étiquette (ils tombent dans « Autres » du tableau « Automatisations »). À appeler AVANT de proposer une catégorie à l\'utilisateur.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'etiqueter_ha',
    description: 'POSE (ou retire) des étiquettes sur des entités (automation.*, script.*…). À faire pour CHAQUE automatisation/script déposé, après avoir demandé ou proposé la catégorie à l\'utilisateur. Sans confirme:true, aperçu seulement (avant/après). Une étiquette inconnue est refusée sauf creer:true (après accord : une nouvelle étiquette = une carte à ajouter au tableau « Automatisations »).',
    inputSchema: {
      type: 'object',
      properties: {
        entites: { type: 'array', items: { type: 'string' }, description: 'entity_id à étiqueter' },
        etiquettes: { type: 'array', items: { type: 'string' }, description: 'Noms ou identifiants d\'étiquettes' },
        mode: { type: 'string', enum: ['ajouter', 'remplacer', 'retirer'], description: 'Défaut : ajouter' },
        creer: { type: 'boolean', description: 'Autorise la création d\'une étiquette inconnue' },
        confirme: CONFIRM_PROP
      },
      required: ['entites', 'etiquettes']
    }
  }
];

/** Gestion des pilotes (AREXX, RFXCOM…) par MQTT via le cœur — conception-gestion-pilotes_specs v1.5. */
export const PILOTES_TOOLS: McpToolDef[] = [
  {
    name: 'pilotes_ponts',
    description: "Liste les PONTS de pilotes du site (une instance d'un pilote sur une machine : arexx_bridge_<machine>, rfx_bridge_<machine>…), toutes machines confondues : type, machine, joignable, capacités (ordres acceptés). À appeler EN PREMIER : s'il y a plusieurs ponts du type voulu, demander à l'utilisateur lequel. LECTURE SEULE.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'pilotes_lire',
    description: "Lit un pont (LECTURE SEULE). ordre `lister` : ressources configurées (AREXX : capteurs ; RFXCOM : devices, recepteurs, scenes — filtre `parametres.ressource`). ordre `decouverts` : appareils détectés mais pas encore adoptés (id, dernière valeur, qualité du signal).",
    inputSchema: {
      type: 'object',
      properties: {
        pont: { type: 'string', description: 'Nom complet du pont (voir pilotes_ponts)' },
        ordre: { type: 'string', enum: ['lister', 'decouverts'] },
        parametres: { type: 'object', description: 'Optionnel. RFXCOM lister : { ressource: "devices" | "recepteurs" | "scenes" }' }
      },
      required: ['pont', 'ordre']
    }
  },
  {
    name: 'pilotes_modifier',
    description:
      "Ordre MODIFIANT sur un pont : adopter (qualifier un découvert : id, quoi, lieu, lieuPrecis, lieuPere?, lieuGrandPere?, transmitToHa — quoi et lieu sont obligatoires), creer (RFXCOM : ressource recepteur|scene|device), modifier, remplacer (ancien, nouveau : le neuf reprend le nom de l'ancien et le même entity_id), effacer (oublie un découvert), ignorer, supprimer (retire aussi l'entité de HA), redemarrer. " +
      "Sans confirme:true, renvoie seulement un APERÇU (ce qui serait fait, entités HA touchées) et ne modifie RIEN : le montrer à l'utilisateur et n'envoyer confirme:true (mêmes paramètres) qu'après son accord explicite. Refuse d'appliquer sans aperçu préalable. Une sauvegarde du fichier est faite avant toute écriture. " +
      "NOMMAGE (adopter, creer, modifier) : le nom est composé d'après le protocole QUOI---OÙ à partir de `quoi` (ce que c'est : Température, Bouton, Lumière…) et `lieu` (la pièce) — les DEUX obligatoires —, puis, FACULTATIFS : `lieuPrecis` (sous-zone dans le lieu : coin canapé, évier… ; absent = égal au lieu), `lieuPere` (niveau au-dessus du lieu) et `lieuGrandPere` (niveau au-dessus du père). Le père et le grand-père sont SOUVENT l'étage et le bâtiment, mais ce n'est PAS une règle : ne pas les imposer ni les deviner. Nom obtenu : `quoi---lieuPrecis--lieu--lieuPere--lieuGrandPere`, niveaux absents laissés de côté ; lieuGrandPere exige lieuPere (position dans le nom). Pour reprendre la convention du site, regarder les noms déjà présents (pilotes_lire lister) ; ne demander père / grand-père que s'ils sont d'usage sur ce site ou si l'utilisateur en parle. Avec `modifier`, seules les parties données changent (\"\" efface une partie). " +
      "Poser les questions utiles AVANT (quel pont, quel lieu, transmettre à HA ?) ; pour un remplacement RFXCOM, rappeler que l'appairage physique du module se fait hors dimotic-ha. Les pilotes de production (relais) : prévenir avant un redémarrage.",
    inputSchema: {
      type: 'object',
      properties: {
        pont: { type: 'string', description: 'Nom complet du pont (voir pilotes_ponts)' },
        ordre: { type: 'string', enum: ['adopter', 'creer', 'modifier', 'remplacer', 'effacer', 'ignorer', 'supprimer', 'redemarrer'] },
        parametres: { type: 'object', description: 'Selon l\'ordre. AREXX adopter : { id, quoi, lieu, lieuPrecis?, lieuPere?, lieuGrandPere?, transmitToHa }. AREXX remplacer : { ancien, nouveau }. RFXCOM voir fonctionnelles-rfxcom §13bis.' },
        confirme: CONFIRM_PROP
      },
      required: ['pont', 'ordre']
    }
  }
];

/** lister_entites côté MCP : comme celui de Mistral + filtre de catégorie HA (réglages / diagnostic). Mistral n'est pas modifié. */
const LISTER_ENTITES_MCP: McpToolDef = {
  name: 'lister_entites',
  description: "Liste les entités Home Assistant connues correspondant à un filtre QUOI/OÙ (les deux paramètres sont optionnels — absents, retourne toutes les entités). Chaque entité porte sa `categorie` HA : 'principale' (commande/mesure), 'config' (réglage : seuils, modes…) ou 'diagnostic'. `categorie` filtre dessus ; sans lui, toutes sont renvoyées (comportement habituel).",
  inputSchema: {
    type: 'object',
    properties: {
      quoi: { type: 'string', description: 'Catégorie QUOI (ex: "lumière", "température")' },
      lieux: { type: 'array', items: { type: 'string' }, description: 'Lieux à filtrer. Plusieurs lieux = l\'un OU l\'autre. Un repère précis avec un lieu = les deux à la fois (ex: ["plafonnier de la chambre"]).' },
      categorie: { type: 'string', enum: ['principale', 'config', 'diagnostic', 'toutes'], description: "Ne garder que les entités de cette catégorie HA (défaut : toutes). 'principale' écarte les réglages et le diagnostic." }
    }
  }
};

export const MCP_ONLY_TOOLS: McpToolDef[] = [
  {
    name: 'obtenir_details',
    description:
      "Détails réels d'entités (LECTURE SEULE) : état, attributs Home Assistant (luminosité, position, température, unité…) " +
      "et classement quoi/lieu précis/pièce/étage. À préférer à obtenir_etat quand on a besoin d'une valeur numérique ou de comprendre " +
      "comment une entité est classée. Donner entity_id, ou un filtre quoi/lieux comme lister_entites.",
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Identifiant exact (ex: light.plafonnier_chambre)' },
        quoi: { type: 'string', description: 'Catégorie QUOI (ex: "lumière")' },
        lieux: { type: 'array', items: { type: 'string' }, description: 'Lieux (voir lister_entites)' },
        limite: { type: 'number', description: 'Nombre maximum d\'entités détaillées (défaut 20, max 50)' }
      }
    }
  },
  {
    name: 'diagnostiquer_resolution',
    description:
      "Explique comment une demande quoi/lieux est résolue (LECTURE SEULE) : le quoi et chaque lieu existent-ils, combien d'entités " +
      "chacun donne seul puis combinés, et les noms proches du catalogue en cas de faute. À utiliser quand lister_entites ne retourne " +
      "pas ce qu'on attend.",
    inputSchema: {
      type: 'object',
      properties: {
        quoi: { type: 'string', description: 'Catégorie QUOI demandée' },
        lieux: { type: 'array', items: { type: 'string' }, description: 'Lieux demandés' }
      }
    }
  },
  {
    name: 'tester_phrase',
    description:
      "Simule une phrase domotique SANS rien exécuter (ni action, ni création de planification) : indique si elle est déjà en cache, " +
      "si l'interpréteur déterministe la reconnaît (énoncés décodés et entités visées) et, seulement si utiliser_mistral vaut true, " +
      "ce que Mistral en ferait en mode simulation (appel facturé).",
    inputSchema: {
      type: 'object',
      properties: {
        phrase: { type: 'string', description: 'Phrase à tester, comme dite à la maison (ex: "allume le plafonnier de la chambre")' },
        utiliser_mistral: { type: 'boolean', description: 'Si la phrase n\'est pas reconnue localement, interroger aussi Mistral en simulation (défaut false)' }
      },
      required: ['phrase']
    }
  }
];

MCP_ONLY_TOOLS.push({
  name: 'lire_planificateur',
  description:
    "Lit les données du planificateur (LECTURE SEULE, rien n'est modifié) : planifications et macros existantes, ce que le " +
    "planificateur a reçu de l'assistant (actions_recues), et ce qui a réellement été envoyé à Home Assistant à chaque exécution " +
    "(commandes_ha : résolu ou non, entité visée, erreur). Sections : statut, planifications, macros, actions_recues, " +
    "commandes_ha, yaml. Sans `nom`, planifications et macros sont résumées ; avec `nom`, la définition complète.",
  inputSchema: {
    type: 'object',
    properties: {
      section: { type: 'string', enum: ['statut', 'planifications', 'macros', 'actions_recues', 'commandes_ha', 'yaml'], description: 'Donnée à lire' },
      nom: { type: 'string', description: 'Nom (ou numéro, pour une planification) d\'une planification ou macro : définition complète. Obligatoire pour yaml.' },
      limite: { type: 'number', description: 'Nombre maximum d\'éléments pour actions_recues et commandes_ha (défaut 10, max 30)' }
    },
    required: ['section']
  }
});

/** Les trois outils de Mistral, au format MCP, puis ceux propres à Claude Code. */
export const MCP_TOOLS: McpToolDef[] = [
  ...IA_TOOLS.map((t) => t.function.name === 'lister_entites' ? LISTER_ENTITES_MCP : ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters })),
  ...MCP_ONLY_TOOLS,
  ...HA_AUTOMATION_TOOLS,
  ...HA_ENTITE_TOOLS,
  ...HA_AIDE_TOOLS,
  ...HA_TABLEAU_TOOLS,
  ...HA_SCRIPT_TOOLS,
  ...HA_PIECE_TOOLS,
  ...HA_ETIQUETTE_TOOLS,
  ...HA_AUDIT_TOOLS,
  ...HA_REFERENCES_TOOLS,
  ...PILOTES_TOOLS
];

const NOISY_ATTRIBUTES = new Set(['entity_picture', 'icon', 'supported_features', 'attribution', 'friendly_name', 'editable', 'restored', 'attributs_taxonomie']);
const MAX_DETAILS = 50;

function slugify(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** Noms du catalogue proches de `term` (fautes de frappe, pluriel, mot contenu) — jamais plus de 3. */
function closest(term: string, candidates: string[]): string[] {
  const t = slugify(term);
  if (!t) return [];
  return candidates
    .map((name) => ({ name, d: slugify(name).includes(t) || t.includes(slugify(name)) ? 0 : distance(t, slugify(name)) }))
    .filter((c) => c.d <= Math.max(2, Math.floor(t.length / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((c) => c.name);
}

/** actions_recues porte `request`/`reply` en TEXTE JSON : les rendre structurés pour qu'ils se lisent. */
function parseJsonStrings(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object') return entry;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
    if ((key === 'request' || key === 'reply') && typeof value === 'string') {
      try { out[key] = JSON.parse(value); continue; } catch { /* texte brut conservé */ }
    }
    out[key] = value;
  }
  return out;
}

function trimValue(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (Array.isArray(value)) return value.length > 20 ? [...value.slice(0, 20).map(trimValue), `… (${value.length} éléments)`] : value.map(trimValue);
  return value;
}

export interface McpToolboxDeps {
  toolExecutor: ToolExecutor;
  registry: HaLecture;
  excludedQuoiIds: () => string[];
  /** Simulation d'une phrase (IaService.simulatePhrase). */
  simulate: (phrase: string, useMistral: boolean) => Promise<unknown>;
  /** Lecture du planificateur (PlannerReader). */
  planner: PlannerReader;
  /** Automatisations HA (lecture / dépôt / suppression, via le pont REST du core). */
  automations: HaAutomationClient;
  /** Scripts de HA (même client, domaine `script`). */
  scripts: HaAutomationClient;
  /** Renommage d'entités HA (registre des entités). */
  entites: HaEntiteRenamer;
  /** Aides HA (timer, input_*…). */
  aides: HaAideClient;
  /** Tableaux de bord et Énergie de HA. */
  tableaux: HaTableauClient;
  /** Pièces (areas) de HA. */
  pieces: HaPieceClient;
  /** Étiquettes de HA. */
  etiquettes: HaEtiquetteClient;
  /** Audit des noms (lecture seule). */
  audit: HaAuditNomsClient;
  /** Renommage d'appareil. */
  appareils: HaAppareilRenamer;
  /** Vérification des références d'entités (lecture seule). */
  references: HaReferencesClient;
  /** Gestion des pilotes via le cœur (PilotesClient). */
  pilotes: PilotesClient;
}

export class McpToolbox {
  constructor(private readonly deps: McpToolboxDeps) {}

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'obtenir_details': return JSON.stringify(await this.details(args), null, 2);
      case 'diagnostiquer_resolution': return JSON.stringify(await this.diagnose(args), null, 2);
      case 'lire_planificateur': return JSON.stringify(await this.readPlanner(args), null, 2);
      case 'lire_automatisations_ha': return JSON.stringify(await this.readAutomations(args), null, 2);
      case 'deposer_automatisation': return JSON.stringify(await this.deps.automations.deposit(String(args.id ?? ''), args.definition, args.confirme === true), null, 2);
      case 'supprimer_automatisation': return JSON.stringify(await this.deps.automations.remove(String(args.id ?? ''), args.confirme === true), null, 2);
      case 'verifier_entity_ids': return JSON.stringify(await this.deps.references.verifier(Array.isArray(args.portee) ? args.portee.map(String) : undefined), null, 2);
      case 'auditer_noms_ha': return JSON.stringify(await this.deps.audit.auditer(
        args.portee === 'appareils' || args.portee === 'identifiants' ? args.portee : 'tous',
        typeof args.limite === 'number' ? args.limite : 40), null, 2);
      case 'renommer_appareil_ha': return JSON.stringify(await this.deps.appareils.renommer(String(args.device_id ?? ''), String(args.nom ?? ''), args.confirme === true), null, 2);
      case 'lire_etiquettes_ha': return JSON.stringify(await this.deps.etiquettes.lire(), null, 2);
      case 'etiqueter_ha': return JSON.stringify(await this.deps.etiquettes.etiqueter(
        Array.isArray(args.entites) ? args.entites.map(String) : [],
        Array.isArray(args.etiquettes) ? args.etiquettes.map(String) : [],
        args.mode === 'remplacer' || args.mode === 'retirer' ? args.mode : 'ajouter',
        args.creer === true, args.confirme === true), null, 2);
      case 'lire_pieces_ha': return JSON.stringify(await this.deps.pieces.lire(), null, 2);
      case 'affecter_piece_ha': return JSON.stringify(await this.deps.pieces.affecter(
        Array.isArray(args.entites) ? args.entites.map(String) : [], Array.isArray(args.appareils) ? args.appareils.map(String) : [],
        String(args.piece ?? ''), args.confirme === true), null, 2);
      case 'renommer_piece_ha': return JSON.stringify(await this.deps.pieces.renommer(String(args.piece ?? ''), String(args.nouveau_nom ?? ''), args.confirme === true), null, 2);
      case 'supprimer_pieces_vides_ha': return JSON.stringify(await this.deps.pieces.supprimerVides(Array.isArray(args.pieces) ? args.pieces.map(String) : undefined, args.confirme === true), null, 2);
      case 'lire_scripts_ha': return JSON.stringify(await this.readScripts(args), null, 2);
      case 'deposer_script': return JSON.stringify(await this.deps.scripts.deposit(String(args.id ?? ''), args.definition, args.confirme === true), null, 2);
      case 'supprimer_script': return JSON.stringify(await this.deps.scripts.remove(String(args.id ?? ''), args.confirme === true), null, 2);
      case 'lire_tableaux_de_bord': return JSON.stringify(await this.deps.tableaux.lire(args.url_path === undefined ? undefined : String(args.url_path)), null, 2);
      case 'deposer_tableau_de_bord': {
        const up = String(args.url_path ?? '');
        return JSON.stringify(await this.deps.tableaux.deposer(up === '' ? null : up, args.config, args.creer as { titre?: string; icone?: string } | undefined, args.confirme === true), null, 2);
      }
      case 'lire_energie': return JSON.stringify(await this.deps.tableaux.lireEnergie(), null, 2);
      case 'deposer_energie': return JSON.stringify(await this.deps.tableaux.deposerEnergie(args.prefs, args.confirme === true), null, 2);
      case 'creer_aide_ha': {
        const domaine = String(args.domaine ?? '');
        const action = String(args.action ?? 'creer');
        if (action === 'lister') return JSON.stringify(await this.deps.aides.lister(domaine), null, 2);
        if (action === 'supprimer') return JSON.stringify(await this.deps.aides.supprimer(domaine, String(args.id ?? ''), args.confirme === true), null, 2);
        return JSON.stringify(await this.deps.aides.creer(domaine, String(args.nom ?? ''), (args.options ?? {}) as Record<string, unknown>, args.confirme === true), null, 2);
      }
      case 'renommer_entite_ha': return JSON.stringify(await this.deps.entites.renommer(String(args.entity_id ?? ''), args.nouvel_entity_id === undefined ? undefined : String(args.nouvel_entity_id), args.nom === undefined ? undefined : String(args.nom), args.confirme === true), null, 2);
      case 'pilotes_ponts': return JSON.stringify(await this.deps.pilotes.ponts(), null, 2);
      case 'pilotes_lire': return JSON.stringify(await this.deps.pilotes.lire(String(args.pont ?? ''), String(args.ordre ?? ''), (args.parametres ?? {}) as Record<string, unknown>), null, 2);
      case 'pilotes_modifier': return JSON.stringify(await this.deps.pilotes.modifier(String(args.pont ?? ''), String(args.ordre ?? ''), (args.parametres ?? {}) as Record<string, unknown>, args.confirme === true), null, 2);
      case 'lister_entites': return this.listEntities(args);
      case 'tester_phrase': return JSON.stringify(await this.deps.simulate(String(args.phrase ?? ''), args.utiliser_mistral === true), null, 2);
      default:
        return this.deps.toolExecutor.execute({ id: `mcp-${Date.now()}`, type: 'function', function: { name, arguments: args } });
    }
  }

  /** lister_entites : résolution identique à Mistral (ToolExecutor), puis catégorie HA et filtre optionnel. */
  private async listEntities(args: Record<string, unknown>): Promise<string> {
    if (!this.deps.registry.isAvailable()) return JSON.stringify({ error: 'référentiel HA indisponible' });
    const quoi = typeof args.quoi === 'string' && args.quoi ? slugify(args.quoi) : undefined;
    const lieux = Array.isArray(args.lieux) ? (args.lieux as string[]) : [];
    // includeTechnical : côté MCP on voit TOUT (avec la catégorie) ; Mistral, lui, n'a que les entités « utilisateur ».
    const all = await this.deps.registry.getEntitiesByQuoiAndLieux(quoi, lieux, true);
    const wanted = typeof args.categorie === 'string' ? args.categorie : 'toutes';
    const entities = all
      .map((e) => ({ entity_id: e.entity_id, name: e.friendly_name, categorie: e.entity_category ?? 'principale', ...(e.disabled_by ? { desactivee_par: e.disabled_by } : {}) }))
      .filter((e) => wanted === 'toutes' || e.categorie === wanted);
    return JSON.stringify({ entities, ...(wanted !== 'toutes' ? { filtre_categorie: wanted, ecartees: all.length - entities.length } : {}) });
  }

  private async readScripts(args: Record<string, unknown>): Promise<unknown> {
    const r = await this.readAutomations(args, this.deps.scripts);
    // la liste d'un script porte `automatisations` dans la version générique : renommée
    return r && typeof r === 'object' && 'automatisations' in (r as object)
      ? { total: (r as { total: number }).total, scripts: (r as { automatisations: unknown }).automatisations }
      : r;
  }

  private async readAutomations(args: Record<string, unknown>, client?: HaAutomationClient): Promise<unknown> {
    const automations = client ?? this.deps.automations;
    const id = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : undefined;
    if (args.sauvegardes === true) {
      if (typeof args.fichier === 'string' && args.fichier) {
        const content = automations.readBackup(args.fichier);
        return content === undefined ? { error: `sauvegarde « ${args.fichier} » introuvable` } : { fichier: args.fichier, definition: content };
      }
      return { sauvegardes: automations.listBackups(id) };
    }
    if (id) {
      const read = await automations.get(id);
      return read.ok ? { id, definition: read.config } : { error: read.error };
    }
    const list = automations.list();
    return { total: list.length, automatisations: list };
  }

  private async readPlanner(args: Record<string, unknown>): Promise<unknown> {
    const section = String(args.section ?? '') as PlannerSection;
    const nom = typeof args.nom === 'string' && args.nom.trim() ? args.nom.trim() : undefined;
    const limit = Math.min(Math.max(Number(args.limite) || 10, 1), 30);
    const planner = this.deps.planner;

    if (section === 'yaml') {
      if (!nom) return { error: 'nom obligatoire pour la section yaml' };
      const read = await planner.readYaml(nom);
      return read.data === undefined ? { error: `planificateur n'a pas fourni le YAML de « ${nom} » (inconnue, ou planificateur ne répond pas)` } : { yaml: read.data, frais: read.frais };
    }
    if (!['statut', 'planifications', 'macros', 'actions_recues', 'commandes_ha'].includes(section)) {
      return { error: `section inconnue : ${section}` };
    }

    const read = await planner.read(section as Exclude<PlannerSection, 'yaml'>);
    if (read.data === undefined) return { error: 'planificateur ne répond pas et aucune donnée connue (application arrêtée ou désactivée ?)' };
    const meta = { frais: read.frais, recu_a: read.recu_a, ...(read.frais ? {} : { avertissement: 'planificateur n\'a pas répondu à temps : dernière donnée connue' }) };

    if (section === 'statut') return { ...meta, statut: read.data };

    if (section === 'planifications') {
      const plans = (read.data as Array<Record<string, unknown>>) ?? [];
      if (nom) {
        const found = plans.find((p) => p.name === nom || String(p.id) === nom);
        return found ? { ...meta, planification: found } : { ...meta, error: `planification « ${nom} » introuvable`, noms: plans.map((p) => `${p.id ?? '?'} : ${p.name}`) };
      }
      return {
        ...meta,
        total: plans.length,
        planifications: plans.map((p) => ({
          id: p.id, nom: p.name, active: p.active, phrase_originale: p.phrase_originale, declencheur: p.trigger,
          prochain_declenchement: p.next_fire_at, manquee: p.missed, anomalie: p.anomalie, terminee_le: p.completed_at
        }))
      };
    }

    if (section === 'macros') {
      const macros = (read.data as Array<{ name: string; steps?: unknown[] }>) ?? [];
      if (nom) {
        const found = macros.find((m) => m.name === nom);
        return found ? { ...meta, macro: found } : { ...meta, error: `macro « ${nom} » introuvable`, noms: macros.map((m) => m.name) };
      }
      return { ...meta, total: macros.length, macros: macros.map((m) => ({ nom: m.name, etapes: m.steps?.length ?? 0 })) };
    }

    // actions_recues / commandes_ha : les plus récentes d'abord (déjà l'ordre de planificateur)
    const list = Array.isArray(read.data) ? read.data : [];
    return { ...meta, total: list.length, elements: list.slice(0, limit).map(parseJsonStrings) };
  }

  private async details(args: Record<string, unknown>): Promise<unknown> {
    const registry = this.deps.registry;
    if (!registry.isAvailable()) return { error: 'référentiel HA indisponible' };
    const limit = Math.min(Math.max(Number(args.limite) || 20, 1), MAX_DETAILS);
    if (typeof args.entity_id === 'string' && args.entity_id) await registry.fresh(); // état courant, pas celui de l'instantané

    const entities = typeof args.entity_id === 'string' && args.entity_id
      ? [registry.getEntity(args.entity_id)].filter((e) => e !== undefined)
      : await registry.getEntitiesByQuoiAndLieux(
          typeof args.quoi === 'string' && args.quoi ? slugify(args.quoi) : undefined,
          Array.isArray(args.lieux) ? (args.lieux as string[]) : [],
          true
        );

    return {
      total: entities.length,
      tronque: entities.length > limit,
      entites: entities.slice(0, limit).map((e) => {
        const taxonomy = (e!.attributes?.attributs_taxonomie ?? {}) as Record<string, unknown>;
        const attributs: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(e!.attributes ?? {})) {
          if (!NOISY_ATTRIBUTES.has(key)) attributs[key] = trimValue(value);
        }
        return {
          entity_id: e!.entity_id,
          nom: e!.friendly_name,
          domaine: e!.domain,
          device_class: e!.device_class,
          etat: e!.state,
          zone_ha: e!.area_id,
          categorie: e!.entity_category ?? 'principale',
          desactivee_par: e!.disabled_by ?? undefined,
          masquee_par: e!.hidden_by ?? undefined,
          integration: e!.platform,
          classement: {
            quoi: taxonomy.quoi ?? taxonomy.slug_quoi,
            quoi_appareil: taxonomy.quoi_appareil,
            lieu_precis: taxonomy.lieu_precis,
            lieu: taxonomy.lieu_principal,
            lieu_pere: taxonomy.lieu_pere,
            lieu_grand_pere: taxonomy.lieu_grand_pere
          },
          attributs
        };
      })
    };
  }

  private async diagnose(args: Record<string, unknown>): Promise<unknown> {
    const registry = this.deps.registry;
    if (!registry.isAvailable()) return { error: 'référentiel HA indisponible' };
    const quoi = typeof args.quoi === 'string' && args.quoi ? args.quoi : undefined;
    const lieux = Array.isArray(args.lieux) ? (args.lieux as string[]) : [];
    const quoiSlug = quoi ? slugify(quoi) : undefined;

    const excluded = new Set(this.deps.excludedQuoiIds());
    const quoiCatalog = registry.getQuoiCatalog().filter((q) => !excluded.has(q.quoi_id));
    const quoiNames = quoiCatalog.map((q) => q.label || q.quoi_id);
    const lieuNames = registry.getLieuCatalog(excluded);
    const find = (slug: string | undefined, ls: string[]) => registry.getEntitiesByQuoiAndLieux(slug, ls, true);

    const notes: string[] = [];
    const quoiInfo = quoiSlug
      ? await (async () => {
          const known = quoiCatalog.find((q) => q.quoi_id === quoiSlug || slugify(q.label || '') === quoiSlug);
          const count = (await find(quoiSlug, [])).length;
          if (!known && count === 0) notes.push(`« ${quoi} » n'est pas un QUOI connu.`);
          return { demande: quoi, connu: Boolean(known), entites: count, proches: known ? [] : closest(quoi!, quoiNames) };
        })()
      : undefined;

    const lieuxInfo = [];
    for (const lieu of lieux) {
      const seul = (await find(undefined, [lieu])).length;
      const avecQuoi = quoiSlug ? (await find(quoiSlug, [lieu])).length : seul;
      const connu = lieuNames.some((n) => slugify(n) === slugify(lieu));
      if (seul === 0) notes.push(`Aucune entité pour le lieu « ${lieu} », tous quoi confondus.`);
      else if (quoiSlug && avecQuoi === 0) notes.push(`Le lieu « ${lieu} » existe (${seul} entité(s)) mais aucune n'est de quoi « ${quoi} ».`);
      const proches = connu ? [] : closest(lieu, lieuNames);
      if (!connu && seul > 0) notes.push(`« ${lieu} » n'est pas un lieu du catalogue (entités trouvées seulement par leur nom)${proches.length ? ` — vouliez-vous dire : ${proches.join(', ')} ?` : ''}.`);
      lieuxInfo.push({ demande: lieu, dans_catalogue: connu, entites_tous_quoi: seul, entites_avec_ce_quoi: avecQuoi, proches });
    }

    const combine = await find(quoiSlug, lieux);
    if (combine.length === 0 && notes.length === 0) {
      notes.push('Chaque critère donne des entités séparément mais aucune ne les satisfait ensemble.');
    }

    return {
      demande: { quoi, lieux },
      resultat: { entites: combine.length, entity_ids: combine.slice(0, 30).map((e) => e.entity_id) },
      quoi: quoiInfo,
      lieux: lieuxInfo,
      remarques: notes
    };
  }
}
