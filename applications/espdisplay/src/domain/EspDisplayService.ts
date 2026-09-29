/**
 * EspDisplayService — orchestrateur des écrans ESP (ESPHome/LVGL).
 *
 * Écoute l'événement générique `espdisplay:deploy-floorplan` sur l'EventBus partagé (même pattern
 * que ArexxService/Evoo7Service -> IntegrationBridge, voir integration:bridge:register) et exécute
 * le pipeline Python qui génère les widgets, fusionne le YAML ESPHome et lance la compilation dans
 * le conteneur Docker `esphome` — localement si ce service tourne sur la machine qui héberge ce
 * conteneur (falbala), ou via SSH (clé dédiée, commande forcée côté cible) sinon — voir
 * `config.remote` et §6.2 de fonctionnelles-espdisplay_specs. Cas découvert le 14/08/2026 : le
 * bouton HAPLAN "Déployer sur l'écran" échouait depuis ha2 (ENOENT sur python3) — ha2 n'a
 * volontairement ni Python ni le conteneur esphome (Pi4, RAM insuffisante pour ESP-IDF).
 *
 * Pas encore d'OTA automatique après compilation — le flash reste manuel.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { IEventBus, Logger, IAppConfigProvider } from '../../../core/dist/exports';
import { ensureGlobalSshKey } from '../../../core/dist/exports';
import { espDisplayConfigSchema, type EspDisplayConfig } from './config-schema';

export interface EspDisplayDeployRequest {
  /** Identifiant du plan HAPLAN à déployer (ex: "original"), ou omis pour --all. */
  floorplanId?: string;
}

export interface EspDisplayDeployResult {
  floorplanId?: string;
  ok: boolean;
  message: string;
  durationMs: number;
}

export interface IEspDisplayService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const ESPDISPLAY_EVENTS = {
  DEPLOY_FLOORPLAN: 'espdisplay:deploy-floorplan',
  DEPLOY_RESULT: 'espdisplay:deploy-result'
} as const;

export class EspDisplayService implements IEspDisplayService {
  private config: EspDisplayConfig;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<EspDisplayConfig>
  ) {
    this.config = espDisplayConfigSchema.parse(configProvider.getAppConfig());
    this.setupEventListeners();
    // ⭐ 29/09/2026 — réglages communs : un config.yaml reçu d'une autre machine (diffusion) ou
    // enregistré depuis la page est relu sans redémarrer l'application.
    this.eventBus.onGeneric<{ moduleId: string; success: boolean }>('app:module:config:saved', (e) => {
      if (e?.moduleId !== 'espdisplay' || !e.success) return;
      this.configProvider.reload?.();
      this.config = espDisplayConfigSchema.parse(this.configProvider.getAppConfig());
      this.logger.info('EspDisplayService', `Réglages relus — machine ESPHome : ${this.config.remote.host || 'non renseignée'}`);
    });
  }

  static create(
    eventBus: IEventBus,
    logger: Logger,
    configProvider: IAppConfigProvider<EspDisplayConfig>
  ): EspDisplayService {
    return new EspDisplayService(eventBus, logger, configProvider);
  }

  private setupEventListeners(): void {
    this.eventBus.onGeneric<EspDisplayDeployRequest>(ESPDISPLAY_EVENTS.DEPLOY_FLOORPLAN, (payload) => {
      this.handleDeployFloorplan(payload ?? {}).catch((error) => {
        this.logger.error('EspDisplayService', `Échec du déploiement : ${error}`);
      });
    });
  }

  async start(): Promise<void> {
    const mode = this.config.remote.host
      ? `par SSH vers ${this.config.remote.sshUser}@${this.config.remote.host}`
      : 'impossible : machine ESPHome non renseignée (obligatoire)';
    this.logger.info('EspDisplayService', `Démarrage — exécution ${mode}, conteneur: ${this.config.esphomeContainer}`);
  }

  async stop(): Promise<void> {
    this.logger.info('EspDisplayService', 'Arrêt du service espdisplay');
  }

  private async handleDeployFloorplan(request: EspDisplayDeployRequest): Promise<void> {
    const start = Date.now();
    const label = request.floorplanId ?? 'tous les plans';
    const planArg = request.floorplanId ?? '--all';
    this.logger.info('EspDisplayService', `Déploiement demandé : ${label}`);

    // ⭐ 29/09/2026 (spec v1.3) : machine ESPHome obligatoire, plus d'exécution locale implicite.
    const result = this.config.remote.host
      ? await this.runPipelineRemote(planArg)
      : { ok: false, message: 'Machine ESPHome non renseignée : Paramètres Techniques › Écrans ESP › Hôte (obligatoire)' };
    const durationMs = Date.now() - start;

    const deployResult: EspDisplayDeployResult = {
      floorplanId: request.floorplanId,
      ok: result.ok,
      message: result.message,
      durationMs
    };

    if (result.ok) {
      this.logger.info('EspDisplayService', `Déploiement réussi (${label}, ${durationMs}ms)`);
    } else {
      this.logger.error('EspDisplayService', `Échec du déploiement (${label}, ${durationMs}ms) : ${result.message}`);
    }

    this.eventBus.emitGeneric<EspDisplayDeployResult>(ESPDISPLAY_EVENTS.DEPLOY_RESULT, deployResult);
  }

  /**
   * Exécution à distance (SSH, clé dédiée) — nécessaire quand ce service tourne sur une machine
   * sans conteneur esphome ni python3 (ex: ha2, voir config-schema.ts). Un seul argument envoyé
   * (l'identifiant de plan, ou "--all") : la cible fait tourner une COMMANDE FORCÉE
   * (~/bin/espdisplay-agent-run.sh, voir en-tête du fichier) qui reconstruit elle-même l'appel
   * complet du pipeline — cette clé ne permet donc rien d'autre que ce pipeline précis.
   *
   * `UserKnownHostsFile` pointé vers data/espdisplay/ (volume persisté, voir compose.yaml) plutôt
   * que le défaut ($HOME, jamais persisté sur ce conteneur — voir Dockerfile "pas de volume nommé
   * sur /app") : sans ça, la clé hôte de la cible ne serait jamais mémorisée d'un redémarrage de
   * conteneur à l'autre. `accept-new` = confiance au premier contact (TOFU), mais rejette bien un
   * changement ultérieur de clé hôte (utile si jamais compromis) — pas un simple désactivation de
   * la vérification. Découvert en testant en conditions réelles le 14/08/2026 ("Host key
   * verification failed" depuis le conteneur ha2 vers falbala).
   */
  private runPipelineRemote(planArg: string): Promise<{ ok: boolean; message: string }> {
    const target = this.config.remote;
    const knownHostsPath = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'espdisplay', 'machine_known_hosts');
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${knownHostsPath}`
    ];
    // ⭐ 29/09/2026 : clé SSH unique de l'installation (comme les autres cibles), script agent appelé
    // explicitement (plus de commande forcée liée à une clé dédiée). L'argument passe par le shell
    // distant : son format est donc contrôlé ici.
    if (!/^(--all|[A-Za-z0-9_.-]{1,100})$/.test(planArg)) {
      return Promise.resolve({ ok: false, message: `Identifiant de plan refusé : ${planArg}` });
    }
    // Réglages de la machine ESPHome transmis au script agent (qui les codait en dur) : conteneur,
    // dossier de config, binaire Python, script (vide = celui du dépôt sur cette machine).
    const extra = [this.config.esphomeContainer, this.config.esphomeConfigDir, this.config.pythonBin, this.config.pipelineScriptPath];
    if (extra.some((v) => v && !/^[A-Za-z0-9_.\/~-]{1,200}$/.test(v))) {
      return Promise.resolve({ ok: false, message: 'Réglage ESPHome refusé (caractères non autorisés) : conteneur, dossier, Python ou script' });
    }
    args.push('-i', ensureGlobalSshKey());
    args.push(`${target.sshUser}@${target.host}`, '~/bin/espdisplay-agent-run.sh', planArg, ...extra.map((v) => v || "''"));
    return this.runProcess('ssh', args);
  }

  private runProcess(command: string, args: string[]): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve) => {
      const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';

      proc.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });
      proc.stderr.on('data', (chunk) => {
        output += chunk.toString();
      });

      proc.on('error', (error) => {
        resolve({ ok: false, message: `Impossible de lancer ${command} : ${error.message}` });
      });

      proc.on('close', (code) => {
        const tail = output.trim().split('\n').slice(-20).join('\n');
        resolve({
          ok: code === 0,
          message: code === 0 ? tail : `Code de sortie ${code}\n${tail}`
        });
      });
    });
  }
}
