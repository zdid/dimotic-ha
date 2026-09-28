/**
 * Extraction de la taxonomie QUOI/OÙ depuis un `name` au format `quoi---lieu_precis--lieu--...`
 * (nommage_specs_v1.0.md). RECOPIÉ de applications/rfxcom/src/domain/taxonomy.ts (décision
 * utilisateur 28/09/2026, fonctionnelles-tasmota_specs §2 D2 : pas encore factorisé dans le core) —
 * garder les deux copies alignées. Ajouts propres à Tasmota en fin de fichier.
 */

export interface ExtractedTaxonomy {
  rawQuoi: string;
  slugQuoi: string;
  nomPrecis: string | null;
  slugPrecis: string | null;
  nomLieu: string | null;
  slugLieu: string | null;
  nomPere: string | null;
  slugPere: string | null;
  nomGrandPere: string | null;
  slugGrandPere: string | null;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

export function extractTaxonomy(fullName: string): ExtractedTaxonomy {
  const parts = fullName.split('---');
  const rawQuoi = (parts[0] || '').trim();
  const lieux = parts[1] ? parts[1].split('--').map((s) => s.trim()) : [];

  const rawPrecis = lieux[0] || null;
  const nomLieu = lieux.length > 1 ? (lieux[1] || null) : (lieux[0] || null);
  // lieu_precis == lieu (y compris le cas à un seul segment, où les deux valaient jusqu'ici le
  // même texte en double) n'apporte aucune information distincte — laissé vide plutôt que
  // dupliqué avec lieu (demande utilisateur, 08/08/2026). buildDisplayName() s'appuyait déjà sur
  // cette égalité pour replier l'affichage sur le quoi ; ce n'était corrigé qu'à l'affichage, pas
  // dans la donnée elle-même (attributs_taxonomie envoyés à HA gardaient le doublon).
  const nomPrecis = rawPrecis && rawPrecis.toLowerCase() === (nomLieu ?? '').toLowerCase() ? null : rawPrecis;
  const nomPere = lieux[2] || null;
  const nomGrandPere = lieux[3] || null;

  return {
    rawQuoi,
    slugQuoi: rawQuoi ? slugify(rawQuoi) : '',
    nomPrecis,
    slugPrecis: nomPrecis ? slugify(nomPrecis) : null,
    nomLieu,
    slugLieu: nomLieu ? slugify(nomLieu) : null,
    nomPere,
    slugPere: nomPere ? slugify(nomPere) : null,
    nomGrandPere,
    slugGrandPere: nomGrandPere ? slugify(nomGrandPere) : null
  };
}

/**
 * Construit un nom de device HA court et lisible, à la place de l'ancienne chaîne de taxonomie

/**
 * Nom de device HA court et lisible (copie de RFXCOM) : lieu précis capitalisé, repli sur le quoi si
 * le lieu précis est absent ou se confond avec la pièce.
 */
export function buildDisplayName(t: ExtractedTaxonomy): string {
  const label = t.nomPrecis && t.nomPrecis !== t.nomLieu ? t.nomPrecis : t.rawQuoi;
  return capitalize(label);
}

export function capitalize(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Bloc `attributs_taxonomie` (même forme que RFXCOM/NOMMAGE, lu par TaxonomyHaClassifier). */
export function buildAttributsTaxonomie(t: ExtractedTaxonomy): Record<string, string | null> {
  return {
    quoi: t.rawQuoi,
    slug_quoi: t.slugQuoi,
    lieu_principal: t.nomLieu,
    slug_lieu: t.slugLieu,
    lieu_precis: t.nomPrecis,
    slug_precis: t.slugPrecis,
    lieu_pere: t.nomPere,
    slug_pere: t.slugPere,
    lieu_grand_pere: t.nomGrandPere,
    slug_grand_pere: t.slugGrandPere
  };
}

// =============================================================================
// Propre à Tasmota (fonctionnelles-tasmota_specs §3.3, §4.1)
// =============================================================================

/** Longueur maximale du DeviceName (décision D14). */
export const DEVICE_NAME_MAX = 60;

/** Le nom suit-il la convention (QUOI et lieu présents) ? Sinon l'appareil est « à nommer ». */
export function isConventionalName(name: string | undefined | null): boolean {
  if (!name || !name.includes('---')) return false;
  const t = extractTaxonomy(name);
  return !!t.rawQuoi && !!t.nomLieu;
}

export interface NameParts {
  quoi: string;
  precis?: string;
  lieu: string;
  pere?: string;
  grandPere?: string;
}

/** Assemble les morceaux saisis dans la fiche : `quoi---précis--lieu--père--grand-père`. */
export function composeDeviceName(p: NameParts): string {
  const clean = (s?: string) => (s ?? '').replace(/-{2,}/g, '-').trim();
  // Positionnel (nommage_specs §3.3) : précis, lieu, père, grand-père. Sans lieu précis, le lieu
  // occupe aussi la 1re place (extractTaxonomy vide alors le précis) ; morceaux vides de fin retirés.
  const lieux = [clean(p.precis) || clean(p.lieu), clean(p.lieu), clean(p.pere), clean(p.grandPere)];
  while (lieux.length > 2 && !lieux[lieux.length - 1]) lieux.pop();
  const segs = lieux.length === 2 && lieux[0].toLowerCase() === lieux[1].toLowerCase() ? [lieux[1]] : lieux;
  return `${clean(p.quoi)}---${segs.join('--')}`;
}

/** Morceaux d'un nom existant, pour préremplir la fiche. */
export function splitDeviceName(name: string): NameParts {
  const t = extractTaxonomy(name);
  return {
    quoi: t.rawQuoi,
    precis: t.nomPrecis ?? '',
    lieu: t.nomLieu ?? '',
    pere: t.nomPere ?? '',
    grandPere: t.nomGrandPere ?? ''
  };
}

/** Nom technique (Topic/Hostname) proposé d'après le nom : sans accents, ≤ 32 caractères. */
export function suggestTopic(p: NameParts): string {
  const base = [p.precis || p.quoi, p.lieu].filter(Boolean).join(' ');
  return slugify(base).slice(0, 32).replace(/_+$/, '');
}
