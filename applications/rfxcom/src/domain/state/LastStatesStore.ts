/**
 * ⭐ 24/09/2026 — derniers états connus (valeurs des capteurs, on/off/niveau des récepteurs,
 * position des volets), SÉPARÉS de la configuration (décision utilisateur : « perdre les derniers
 * états n'est pas grave, mais la config à refaire ça va trop loin »).
 *
 * Avant : ces états vivaient dans `config-rfxcom-devices-v1.0.yaml`, réécrit en entier (+ `.bak`) à
 * chaque trame RF reçue — mesuré sur stfort : ~3 600 réécritures/jour du fichier de config, avec
 * le risque qu'une écriture interrompue abîme la config elle-même.
 *
 * Maintenant : fichier dédié `rfxcom-derniers-etats.json`, écriture REGROUPÉE (une seule écriture
 * `delayMs` après la première modification en attente, quel que soit le nombre de trames reçues
 * entre-temps) + écriture immédiate à l'arrêt (`flush`). Écriture atomique (tmp → rename), pas de
 * `.bak` : un fichier perdu ou illisible = on repart sans derniers états, rien d'autre.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../../../../core/dist/exports';

export interface LastStatesFile {
  savedAt?: string;
  lastAnyValueChangeAt?: string;
  devices: Record<string, { lastValue?: string | number; lastSeen?: string }>;
  receivers: Record<string, { lastOn?: boolean; lastLevel?: number; lastPosition?: number }>;
}

export const EMPTY_LAST_STATES: LastStatesFile = { devices: {}, receivers: {} };

export class LastStatesStore {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pendingSnapshot: (() => LastStatesFile) | undefined;

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
    private readonly delayMs: number = 30_000
  ) {}

  /** Derniers états enregistrés, ou vide si le fichier est absent/illisible (jamais d'exception). */
  load(): LastStatesFile {
    try {
      if (!fs.existsSync(this.filePath)) return { ...EMPTY_LAST_STATES };
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<LastStatesFile>;
      return {
        savedAt: data.savedAt,
        lastAnyValueChangeAt: data.lastAnyValueChangeAt,
        devices: data.devices ?? {},
        receivers: data.receivers ?? {}
      };
    } catch (error) {
      this.logger.warn('LastStatesStore', `Derniers états illisibles (${this.filePath}) — ignorés, repartis de zéro : ${error}`);
      return { ...EMPTY_LAST_STATES };
    }
  }

  /** Demande une écriture groupée : la photo (`snapshot`) est prise AU MOMENT de l'écriture, donc
   *  toujours la plus récente, quel que soit le nombre d'appels entre-temps. */
  scheduleSave(snapshot: () => LastStatesFile): void {
    this.pendingSnapshot = snapshot;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.writePending();
    }, this.delayMs);
  }

  /** Écrit tout de suite ce qui est en attente (arrêt du service). */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.writePending();
  }

  /** Écrit immédiatement une photo donnée (migration depuis l'ancien format). */
  saveNow(snapshot: LastStatesFile): boolean {
    return this.write(snapshot);
  }

  private writePending(): void {
    const snapshot = this.pendingSnapshot;
    this.pendingSnapshot = undefined;
    if (snapshot) this.write(snapshot());
  }

  private write(data: LastStatesFile): boolean {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...data, savedAt: new Date().toISOString() }), 'utf8');
      fs.renameSync(tmp, this.filePath);
      return true;
    } catch (error) {
      this.logger.warn('LastStatesStore', `Écriture des derniers états impossible (${this.filePath}) : ${error}`);
      return false;
    }
  }
}
