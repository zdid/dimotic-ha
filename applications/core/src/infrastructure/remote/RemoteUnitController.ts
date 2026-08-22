/**
 * Contrôle uniforme (start/stop/restart) d'une unité tournant sur une machine distante — voir
 * SshClient.ts pour les primitives SSH sous-jacentes.
 *
 * `deploy` reste volontairement HORS de ce contrôleur : le provisioning (écriture de config,
 * copie d'agent, résolution de dépendances...) diffère trop d'une application à l'autre pour être
 * unifié sans abstraction artificielle — seul le trio start/stop/restart, strictement symétrique
 * entre Docker et systemd, s'y prête. Deux implémentations existent parce que les cibles réelles du
 * projet se répartissent sur les deux : `rpigpio` pilote un conteneur Docker (stfort), `teleinfo`
 * un service systemd (RPi1, pas de Docker sur cette machine — voir DeployService.ts de teleinfo).
 */

import { runSsh, shellQuote, type RemoteTarget, type RemoteOpResult } from './SshClient';

export type RemoteAction = 'deploy' | 'start' | 'stop' | 'restart';

export interface RemoteUnitController {
  start(target: RemoteTarget, unitName: string): Promise<RemoteOpResult>;
  stop(target: RemoteTarget, unitName: string): Promise<RemoteOpResult>;
  restart(target: RemoteTarget, unitName: string): Promise<RemoteOpResult>;
}

export interface RemoteUnitControllerOptions {
  /** Préfixe `sudo` sur la commande distante — nécessaire pour rpigpio/stfort, pas pour teleinfo (connecté en root). */
  useSudo?: boolean;
}

abstract class BaseUnitController implements RemoteUnitController {
  constructor(private readonly options: RemoteUnitControllerOptions = {}) {}

  protected abstract buildCommand(action: 'start' | 'stop' | 'restart', unitName: string): string;

  private async run(target: RemoteTarget, action: 'start' | 'stop' | 'restart', unitName: string): Promise<RemoteOpResult> {
    const command = this.buildCommand(action, unitName);
    const prefixed = this.options.useSudo ? `sudo ${command}` : command;
    const result = await runSsh(target, prefixed);
    return { success: result.success, step: action, error: result.error, output: result.output };
  }

  start(target: RemoteTarget, unitName: string): Promise<RemoteOpResult> {
    return this.run(target, 'start', unitName);
  }

  stop(target: RemoteTarget, unitName: string): Promise<RemoteOpResult> {
    return this.run(target, 'stop', unitName);
  }

  restart(target: RemoteTarget, unitName: string): Promise<RemoteOpResult> {
    return this.run(target, 'restart', unitName);
  }
}

export class DockerContainerController extends BaseUnitController {
  protected buildCommand(action: 'start' | 'stop' | 'restart', unitName: string): string {
    return `docker ${action} ${shellQuote(unitName)}`;
  }
}

export class SystemdUnitController extends BaseUnitController {
  protected buildCommand(action: 'start' | 'stop' | 'restart', unitName: string): string {
    return `systemctl ${action} ${shellQuote(unitName)}`;
  }
}
