/**
 * Chargement et rechargement à chaud du fichier de règles domotiques (regles_mistral.txt, specs
 * §5), et injection en fin de message system existant (ou création si absent).
 */

import * as fs from 'node:fs';
import type { Logger } from '../../../core/dist/exports';
import type { OllamaMessage } from './types';

export class RulesProvider {
  private rules = '';
  private watcher?: fs.FSWatcher;

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger
  ) {}

  load(): void {
    try {
      this.rules = fs.readFileSync(this.filePath, 'utf8');
      this.logger.info('RulesProvider', `Règles chargées depuis ${this.filePath} (${this.rules.length} caractères)`);
    } catch (error) {
      this.logger.error('RulesProvider', `Impossible de lire ${this.filePath}: ${error}`);
      this.rules = '';
    }

    this.watcher?.close();
    try {
      this.watcher = fs.watch(this.filePath, () => {
        this.logger.info('RulesProvider', 'Changement détecté, rechargement des règles');
        this.load();
      });
    } catch (error) {
      this.logger.warn('RulesProvider', `Surveillance du fichier de règles indisponible: ${error}`);
    }
  }

  stop(): void {
    this.watcher?.close();
  }

  getRules(): string {
    return this.rules;
  }

  /** Injecte les règles en fin de message system existant, ou en crée un. */
  inject(messages: OllamaMessage[]): OllamaMessage[] {
    if (!this.rules) {
      this.logger.warn('RulesProvider', 'Aucune règle disponible, injection ignorée');
      return messages;
    }

    const result = [...messages];
    const systemIdx = result.findIndex((m) => m.role === 'system');

    if (systemIdx >= 0) {
      result[systemIdx] = { ...result[systemIdx], content: `${result[systemIdx].content}\n\n${this.rules}` };
    } else {
      result.unshift({ role: 'system', content: this.rules });
    }

    return result;
  }
}
