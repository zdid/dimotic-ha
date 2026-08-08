/**
 * TranslationsRepository
 *
 * Gère les fichiers de traduction de noms d'entité (object_id -> libellé), un par pays, utilisés
 * par NommageService::emitPassthroughDiscovery (voir NommageService.ts pour le pourquoi). Deux
 * répertoires :
 * - Seeds versionnés avec le code : src/defaultconfig/translate-<pays>.yaml (copiés dans
 *   dist/defaultconfig au build, voir package.json).
 * - Fichiers runtime modifiables sans rebuild : data/nommage/translations/translate-<pays>.yaml
 *   (mêmes conventions que ConfigFileManager côté RFXCOM — accès filesystem direct depuis le
 *   domain layer, gitignové, jamais committé).
 *
 * Au démarrage, chaque seed est copié vers le répertoire runtime SANS jamais écraser un fichier
 * déjà présent (une modification manuelle survit donc à un redémarrage ou une mise à jour de
 * l'application) — demande utilisateur 08/08/2026.
 *
 * Si le pays configuré (nommage.language.country) n'a de fichier ni en seed ni en runtime, il est
 * généré à la volée : mêmes clés que translate-france.yaml (liste de référence), valeurs reprises
 * de translate-english.yaml (seul repère fiable en l'absence de vraie traduction) — à corriger
 * manuellement ensuite, aucun mécanisme de mise à jour prévu pour l'instant (décidé plus tard).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { Logger } from '../../../../core/dist/exports';

const REFERENCE_COUNTRY = 'france';
const FALLBACK_COUNTRY = 'english';

export class TranslationsRepository {
  private readonly seedDir: string;
  private readonly runtimeDir: string;

  constructor(private logger: Logger) {
    // __dirname compilé : dist/domain/translations -> dist/defaultconfig (voir package.json build).
    this.seedDir = path.join(__dirname, '..', '..', 'defaultconfig');
    this.runtimeDir = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'nommage', 'translations');
  }

  private fileNameFor(country: string): string {
    return `translate-${country.toLowerCase()}.yaml`;
  }

  private readYamlMap(filePath: string): Record<string, string> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(content);
    return (parsed && typeof parsed === 'object') ? (parsed as Record<string, string>) : {};
  }

  private writeYamlMap(filePath: string, data: Record<string, string>): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, yaml.dump(data, { sortKeys: false }), 'utf-8');
  }

  /** Copie chaque seed vers le répertoire runtime, sans jamais écraser un fichier déjà présent. */
  ensureDefaultsCopied(): void {
    if (!fs.existsSync(this.seedDir)) {
      this.logger.warn('TranslationsRepository', `Répertoire de seeds absent : ${this.seedDir}`);
      return;
    }
    fs.mkdirSync(this.runtimeDir, { recursive: true });

    for (const fileName of fs.readdirSync(this.seedDir)) {
      if (!fileName.endsWith('.yaml')) continue;
      const target = path.join(this.runtimeDir, fileName);
      if (fs.existsSync(target)) continue;
      fs.copyFileSync(path.join(this.seedDir, fileName), target);
      this.logger.info('TranslationsRepository', `Fichier de traduction créé : ${fileName}`);
    }
  }

  /**
   * Charge les traductions du pays demandé. Absent des seeds/runtime -> généré à partir des clés
   * de translate-france.yaml et des valeurs de translate-english.yaml, puis sauvegardé.
   */
  loadCountryTranslations(country: string): Record<string, string> {
    this.ensureDefaultsCopied();

    const targetPath = path.join(this.runtimeDir, this.fileNameFor(country));
    if (fs.existsSync(targetPath)) {
      return this.readYamlMap(targetPath);
    }

    this.logger.warn('TranslationsRepository',
      `Aucun fichier de traduction pour "${country}" — génération depuis "${REFERENCE_COUNTRY}" (clés) + "${FALLBACK_COUNTRY}" (valeurs).`);

    const referencePath = path.join(this.runtimeDir, this.fileNameFor(REFERENCE_COUNTRY));
    const fallbackPath = path.join(this.runtimeDir, this.fileNameFor(FALLBACK_COUNTRY));
    const referenceKeys = fs.existsSync(referencePath) ? this.readYamlMap(referencePath) : {};
    const fallbackValues = fs.existsSync(fallbackPath) ? this.readYamlMap(fallbackPath) : {};

    const generated: Record<string, string> = {};
    for (const key of Object.keys(referenceKeys)) {
      generated[key] = fallbackValues[key] ?? referenceKeys[key];
    }

    this.writeYamlMap(targetPath, generated);
    this.logger.info('TranslationsRepository', `Fichier de traduction généré : ${this.fileNameFor(country)}`);
    return generated;
  }
}
