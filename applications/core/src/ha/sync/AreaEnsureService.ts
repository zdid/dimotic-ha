// src/ha/sync/AreaEnsureService.ts
// Garantit l'existence d'une area HA à partir d'un nom de "lieu" de taxonomie — appelé par
// IntegrationBridge avant de publier une découverte MQTT portant device.suggested_area.
//
// Contexte : suggested_area s'est révélé être une simple suggestion pour l'UI HA, jamais
// auto-appliquée silencieusement (vérifié en conditions réelles — suppression + redécouverte
// complète d'une entité, puis redémarrage complet de HA : area_id reste null dans les deux cas).
// Ce service crée donc l'area nous-mêmes via l'API WebSocket de HA (déterministe), plutôt que de
// dépendre de ce comportement opaque.

import type { HaWsClient } from './HaWsClient';
import type { HaStructureRegistry } from './HaStructureRegistry';
import type { IEventBus } from '../../application/IEventBus';
import type { Logger } from '../../infrastructure/logger/index';
import { guessAreaIcon } from './areaIcons';

// Deux budgets distincts (07/08/2026, corrige un bug constaté en conditions réelles) : le
// référentiel HA (392 entités/34 areas en usage réel) peut mettre plus de 20s à charger, largement
// au-delà de l'ancien timeout unique de 8s — toutes les demandes arrivant juste après connexion
// (rafale de découvertes MQTT retenues) échouaient donc systématiquement, même pour des areas déjà
// existantes. ENSURE_TIMEOUT_MS couvre l'appel WS lui-même (résolution/création, une fois le
// référentiel prêt) — quasi instantané en pratique. Ni lui ni REGISTRY_WAIT_TIMEOUT_MS ne
// s'appliquent quand waitIndefinitely=true (RFXCOM/AREXX/NOMMAGE) — voir resolveOrCreate (⭐
// 10/08/2026 : un device pouvait encore être créé sans area sous charge malgré ce flag, le
// timeout de création n'était jusque-là ignoré que pour l'attente du référentiel, pas pour
// l'appel WS suivant). Les deux timeouts restent actifs pour les apps sans
// waitForHaWsBeforeDiscovery (ex: EVOO7). REGISTRY_WAIT_TIMEOUT_MS est un filet de sécurité large
// pour l'attente du référentiel (ne
// devrait jamais se déclencher en usage normal, apps sans waitIndefinitely uniquement aussi).
const ENSURE_TIMEOUT_MS = 8000;
const REGISTRY_WAIT_TIMEOUT_MS = 60000;

export class AreaEnsureService {
  /**
   * Résolue une fois pour toutes dès que le référentiel HA (areas comprises) est chargé — voir
   * waitUntilRegistryReady. Attendre seulement l'authentification WS ne suffit pas : le
   * chargement du référentiel (AppService.loadHaRegistry, qui peuple HaStructureRegistry) est
   * lui-même asynchrone et déclenché séparément sur le même événement de connexion — sans
   * attendre `ha:ready`, findByName tournait à vide sur un registre encore incomplet et
   * déclenchait des créations en double, rejetées par HA ("name already in use") — constaté en
   * conditions réelles.
   */
  private registryReady = false;
  private registryReadyPromise: Promise<void>;
  private resolveRegistryReady!: () => void;

  /**
   * Demandes de création en cours, par nom capitalisé — au démarrage, de nombreuses entités
   * partageant le même lieu (ex: 8 données EVOO7 sous "Pompe à chaleur") appellent ensureArea
   * quasi simultanément ; sans ce partage, chacune passe le contrôle findByName (aucune n'a encore
   * eu le temps de mettre à jour le cache) et déclenche sa propre création concurrente — constaté
   * en conditions réelles (une seule création WS gagnante par nom, les autres rejetées).
   */
  private pendingCreations: Map<string, Promise<string | undefined>> = new Map();

  constructor(
    private readonly haWsClient: HaWsClient,
    private readonly haStructureRegistry: HaStructureRegistry,
    private readonly eventBus: IEventBus,
    private readonly logger: Logger
  ) {
    this.registryReadyPromise = new Promise((resolve) => { this.resolveRegistryReady = resolve; });

    // ⭐ 10/08/2026 : registryReady était un verrou à sens unique — une fois vrai après le tout
    // premier ha:ready, plus jamais réarmé. Or AppService.loadHaRegistry() reconstruit
    // entièrement HaStructureRegistry (rebuild()) et réémet ha:ready à CHAQUE reconnexion WS, pas
    // seulement au démarrage. Sans ce reset, une reconnexion (ex: redémarrage de HA) laissait
    // ensureArea() croire le référentiel prêt alors qu'il venait d'être vidé et était en cours de
    // rechargement (jusqu'à 20s+ pour un référentiel réel) — findByName() ne trouvait donc plus
    // des areas pourtant déjà créées côté HA, déclenchant des créations en double rejetées
    // ("already in use") en boucle jusqu'à la fin du rechargement. Constaté en conditions réelles :
    // 191 échecs sur une seule reconnexion, contre 0 avant celle-ci.
    this.eventBus.onGeneric('ha:disconnected', () => {
      this.registryReady = false;
      this.registryReadyPromise = new Promise((resolve) => { this.resolveRegistryReady = resolve; });
    });

    // ⭐ Corrigé (18/08/2026, bug réel — RFXCOM jamais découvert côté HA) : ha:ready est un
    // événement PONCTUEL émis très tôt au démarrage (dès le référentiel HA chargé, quasi
    // immédiat). L'abonnement était posé paresseusement dans waitUntilRegistryReady(), à la
    // PREMIÈRE demande d'ensureArea() — pour une app dont le démarrage prend plusieurs secondes
    // (RFXCOM : connexion transceiver série avant son premier ensureArea), ha:ready avait déjà
    // été émis et disparu avant cet abonnement tardif, laissant la promesse attendre indéfiniment
    // un signal qui ne reviendra plus (sauf reconnexion HA) — silencieux, jamais de log, jamais
    // de timeout pour les apps waitIndefinitely (RFXCOM/AREXX/NOMMAGE). Abonnement déplacé ici,
    // au constructeur (une seule fois, jamais réarmé — le reset se fait via registryReadyPromise
    // recréée sur ha:disconnected ci-dessus, ce même abonnement continue de la résoudre ensuite),
    // pour ne jamais rater l'émission quel que soit le moment du premier appel à ensureArea().
    this.eventBus.onGeneric('ha:ready', () => {
      this.registryReady = true;
      this.resolveRegistryReady();
    });
  }

  /**
   * Garantit qu'une area du nom donné existe (la crée si nécessaire), et retourne son area_id.
   * Best-effort par défaut : timeout interne, ne lève jamais — un échec/dépassement retourne
   * `undefined`, l'appelant publie la découverte sans area, comme si suggested_area n'avait pas
   * été fourni.
   *
   * @param waitIndefinitely Si `true` (paramétrage `waitForHaWsBeforeDiscovery` de l'app
   *   appelante, RFXCOM/AREXX/NOMMAGE — décision utilisateur du 08/08/2026), n'abandonne JAMAIS
   *   l'attente du référentiel HA, même après REGISTRY_WAIT_TIMEOUT_MS — HA n'appliquant
   *   suggested_area qu'une seule fois, à la création de l'entité, publier une découverte sans
   *   area par manque de patience la laisserait sans area de façon définitive (réaffectation
   *   manuelle requise, coûteuse à grande échelle). L'appelant (IntegrationBridge) n'appelle donc
   *   `haMqttService.publishDiscoveryFor(...)` qu'une fois cette promesse résolue — la découverte
   *   elle-même attend autant que nécessaire, sans borne.
   */
  async ensureArea(rawName: string, waitIndefinitely = false): Promise<string | undefined> {
    const name = this.capitalize(rawName);
    if (!name) return undefined;

    const pending = this.pendingCreations.get(name);
    if (pending) return pending;

    const creation = this.resolveOrCreate(name, waitIndefinitely).finally(() => this.pendingCreations.delete(name));
    this.pendingCreations.set(name, creation);
    return creation;
  }

  private async resolveOrCreate(name: string, waitIndefinitely: boolean): Promise<string | undefined> {
    if (waitIndefinitely) {
      // Pas de withTimeout ici, volontairement — voir la doc de ensureArea() ci-dessus.
      await this.waitUntilRegistryReady();
    } else {
      try {
        await this.withTimeout(this.waitUntilRegistryReady(), REGISTRY_WAIT_TIMEOUT_MS, `area_ensure:${name}:registry`);
      } catch {
        this.logger.warn('ha:area_ensure', `Échec de la garantie d'area "${name}": référentiel HA jamais prêt après ${REGISTRY_WAIT_TIMEOUT_MS}ms`);
        return undefined;
      }
    }

    // ⭐ 10/08/2026 : l'appel WS de création/résolution lui-même ne doit PAS non plus être borné
    // par ENSURE_TIMEOUT_MS quand waitIndefinitely=true — jusqu'ici ce garde-fou ne couvrait que
    // l'attente du référentiel ci-dessus, pas cet appel. Sous charge (dizaines de devices créant
    // leur area quasi simultanément au démarrage à froid), ce timeout de 8s pouvait encore se
    // déclencher malgré waitIndefinitely=true, publiant la découverte sans area — contraire à
    // l'intention documentée ("n'abandonne JAMAIS"). Le try/catch reste : une vraie erreur WS
    // (pas un timeout) continue de retourner undefined plutôt que de bloquer la publication.
    if (waitIndefinitely) {
      try {
        return await this.resolveOrCreateArea(name);
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        this.logger.warn('ha:area_ensure', `Échec de la garantie d'area "${name}": ${message}`);
        return undefined;
      }
    }

    try {
      return await this.withTimeout(this.resolveOrCreateArea(name), ENSURE_TIMEOUT_MS, `area_ensure:${name}:create`);
    } catch (error) {
      const message = error instanceof Error ? error.message : JSON.stringify(error);
      this.logger.warn('ha:area_ensure', `Échec de la garantie d'area "${name}": ${message}`);
      return undefined;
    }
  }

  private async resolveOrCreateArea(name: string): Promise<string> {
    const existing = this.findByName(name);
    if (existing) return existing.area_id;

    // ⭐ 12/08/2026 : icône assignée à la création à partir du nom (demande utilisateur) — table
    // statique de mots-clés FR, voir areaIcons.ts. undefined si aucun motif connu : HA applique
    // alors son icône par défaut générique, comme avant cette fonctionnalité.
    const created = await this.haWsClient.createArea(name, guessAreaIcon(name));
    // Mis à jour immédiatement (pas seulement via l'événement area_registry_updated poussé de
    // façon asynchrone par HA) — sinon une deuxième demande concurrente pour un nom légèrement
    // différent mais convergent ne le verrait pas encore.
    this.haStructureRegistry.addArea(created);
    this.logger.info('ha:area_ensure', `Area créée: ${created.area_id} (${created.name})`);
    return created.area_id;
  }

  private waitUntilRegistryReady(): Promise<void> {
    if (this.registryReady) return Promise.resolve();
    return this.registryReadyPromise;
  }

  private findByName(name: string): { area_id: string } | undefined {
    const lower = name.toLowerCase();
    return this.haStructureRegistry.getAllAreas().find((area) => area.name.toLowerCase() === lower);
  }

  private capitalize(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return '';
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }

  /**
   * Course entre `promise` et un délai — mais `promise` elle-même n'est jamais annulée : en cas
   * de timeout, elle continue de tourner en arrière-plan (rien ne peut interrompre un appel WS déjà
   * envoyé). Sans le flag `timedOut` ci-dessous, son résultat final (succès ou échec, arrivé après
   * coup) ne serait plus attrapé par personne — silencieusement perdu. Bug réel constaté le
   * 07/08/2026 : des areas créées avec succès en arrière-plan après un timeout n'apparaissaient
   * dans aucun log, aucune trace de leur sort.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Timeout après ${ms}ms`));
      }, ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          if (timedOut) {
            this.logger.info('ha:area_ensure', `${label} : résolu après le timeout (résultat tardif) — ${JSON.stringify(value)}`);
          } else {
            resolve(value);
          }
        },
        (error) => {
          clearTimeout(timer);
          if (timedOut) {
            const message = error instanceof Error ? error.message : JSON.stringify(error);
            this.logger.warn('ha:area_ensure', `${label} : a aussi échoué après le timeout — ${message}`);
          } else {
            reject(error);
          }
        }
      );
    });
  }
}
