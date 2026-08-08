/**
 * Extraction de la taxonomie QUOI/OÙ depuis un `name` au format `quoi---lieu_precis--lieu--...`
 * (spec-nommage-v1.0.md, repris par fonctionnelles-rfxcom_specs_v5.6.md §9.3).
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
 * brute complète (ex: "lumière---plafonnier--cuisine--rez-de-chaussée--maison") — devenue
 * redondante avec l'area HA (device.suggested_area/AreaEnsureService, qui donne déjà le lieu).
 * Priorité au lieu précis (ex: "Plafonnier") ; repli sur le quoi (ex: "Lumière") si le récepteur
 * n'a pas de lieu précis distinct du lieu lui-même (lieu_precis == lieu, ex: juste "cuisine"),
 * pour éviter d'afficher deux fois le même mot que l'area. Capitalisé comme les areas (§8.5.4 v4.18).
 */
export function buildDisplayName(t: ExtractedTaxonomy): string {
  const label = t.nomPrecis && t.nomPrecis !== t.nomLieu ? t.nomPrecis : t.rawQuoi;
  return capitalize(label);
}

/**
 * Nom de device pour un "bouton" (émetteur physique RFXCOM — Lighting1/2/4/5/6, Blinds1 — voir
 * getDefaultComponent : tout sauf RFXSensor/RFXMeter). Contrairement à buildDisplayName (lieu
 * précis seul, area déjà donnée par HA), on garde ici "quoi + lieu précis + lieu" en toutes
 * lettres — un bouton porte le même lieu précis que la lumière qu'il pilote (ex: "Plafonnier"),
 * les deux deviendraient indistinguables par leur seul nom sans le quoi ("Bouton") en préfixe.
 */
export function buildBoutonDisplayName(t: ExtractedTaxonomy): string {
  const parts = [t.rawQuoi];
  if (t.nomPrecis) parts.push(t.nomPrecis);
  if (t.nomLieu && t.nomLieu !== t.nomPrecis) parts.push(t.nomLieu);
  return parts.map(capitalize).join(' ');
}

export function capitalize(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Construit le bloc `attributs_taxonomie` obligatoire du payload de découverte (fonctionnelles-rfxcom_specs §2.6). */
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
