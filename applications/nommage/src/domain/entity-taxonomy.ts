/**
 * Taxonomie PAR ENTITÉ (⭐ 08/10/2026) — nommage_specs : QUOI de l'entité et QUOI de l'appareil.
 *
 * Le nom `QUOI---OÙ` est celui de l'APPAREIL. Jusqu'ici toutes ses entités recevaient ce même QUOI : le capteur de puissance
 * d'un lampadaire, le seuil d'un ballon ou le « mode indicateur » d'un four étaient « lampadaire », « ballon », « four ».
 *
 *  - `quoi_appareil` : le QUOI de l'appareil, toujours renseigné (informatif, et qualificatif de résolution côté core) ;
 *  - `quoi` : ce que l'ENTITÉ est :
 *      0. entité PRINCIPALE (état principal d'un appareil : `switch`, `light`, voies `switch_l1`…) → le QUOI de l'appareil ;
 *      1. le libellé traduit de son identifiant technique (« Disjoncteur puissance », « Mode indicateur »…) ;
 *      2. à défaut, la grandeur de sa classe (puissance, tension, température, pression…, même table que le repli du core) ;
 *      3. à défaut, son NOM BRUT tel que publié (« Learn IR code », « Action »…) : non traduit, et compté comme tel
 *         (`untranslated`) pour que NOMMAGE signale ce qu'il reste à traduire ;
 *      4. à défaut de nom, le QUOI de l'appareil.
 *  - `lieu_precis`, `lieu`, `pere`, `grand_pere` : INCHANGÉS.
 */

export interface EntityTaxonomyInput {
  /** Taxonomie de l'appareil, telle que calculée depuis son nom (`ParsedTaxonomy.haAttributes.attributs_taxonomie`). */
  deviceTaxonomy: Record<string, unknown>;
  /** Libellé traduit de l'identifiant technique de l'entité (table de traduction), s'il existe. */
  translatedLabel?: string;
  /** Entité principale de l'appareil (état principal, voie d'un module) : garde le QUOI de l'appareil, jamais son nom brut. */
  isPrimary?: boolean;
  /** `name` brut de la déclaration, s'il y en a un (une entité principale n'en a pas). */
  rawName?: string;
  /** `device_class` de la déclaration, s'il y en a un. */
  deviceClass?: string;
  /** Grandeur d'une classe (puissance, tension…) — `quoiFromDeviceClass` du core. */
  quoiFromClass: (deviceClass: string | undefined) => { quoi_id: string; label: string } | undefined;
  slugify: (text: string) => string;
}

export interface EntityTaxonomyResult {
  taxonomy: Record<string, unknown>;
  /** L'entité a un nom propre mais aucune traduction : son QUOI est ce nom brut. */
  untranslated: boolean;
}

export function buildEntityTaxonomy(input: EntityTaxonomyInput): EntityTaxonomyResult {
  const device = input.deviceTaxonomy;
  const deviceQuoi = typeof device.quoi === 'string' ? device.quoi : '';
  const deviceSlug = typeof device.slug_quoi === 'string' ? device.slug_quoi : '';

  let quoi = deviceQuoi;
  let slug = deviceSlug;
  let untranslated = false;
  if (!input.isPrimary) {
    const label = input.translatedLabel?.trim();
    const fromClass = input.quoiFromClass(input.deviceClass);
    const raw = input.rawName?.trim();
    if (label) {
      quoi = label;
      slug = input.slugify(label);
    } else if (fromClass) {
      quoi = fromClass.label;
      slug = fromClass.quoi_id;
    } else if (raw) {
      quoi = raw;
      slug = input.slugify(raw);
      untranslated = true;
    }
  }
  // Même grandeur que l'appareil (capteur de température d'un appareil « température ») : on garde la graphie du nom de l'appareil.
  if (slug === deviceSlug) { quoi = deviceQuoi; untranslated = false; }

  return { taxonomy: { ...device, quoi, slug_quoi: slug, quoi_appareil: deviceQuoi, slug_quoi_appareil: deviceSlug }, untranslated };
}
