/**
 * Convention de nom d'un appareil (fonctionnelles-nommage_specs §3.2) : `quoi---[lieu précis--]lieu[--père[--grand-père]]`.
 * Le nom est écrit dans le micrologiciel (`friendly_name`) ; NOMMAGE le lit dans la découverte MQTT et en tire la taxonomie
 * (quoi, lieux), la pièce de HA et la forme de l'identifiant. Changer la taxonomie d'un appareil impose donc un nouvel envoi.
 * Règles reprises de NOMMAGE : lieu précis absent = lieu ; père et grand-père facultatifs, grand-père seulement avec un père.
 */

export interface PartiesNom {
  quoi: string;
  lieuPrecis?: string;
  lieu: string;
  pere?: string;
  grandPere?: string;
}

const net = (s: string | undefined): string => (s ?? '').trim();

/** Nom au format de la convention ; les parties vides sont ignorées. */
export function composerNom(p: PartiesNom): string {
  const segments = [net(p.lieuPrecis), net(p.lieu), net(p.pere), net(p.grandPere)].filter((s) => s !== '');
  return `${net(p.quoi)}---${segments.join('--')}`;
}

/** Problèmes d'un nom (liste vide = valide). */
export function validerNom(p: PartiesNom): string[] {
  const erreurs: string[] = [];
  const champs: Array<[string, string]> = [['quoi', net(p.quoi)], ['lieu précis', net(p.lieuPrecis)], ['lieu', net(p.lieu)], ['père', net(p.pere)], ['grand-père', net(p.grandPere)]];
  if (!net(p.quoi)) erreurs.push('le QUOI est vide');
  if (!net(p.lieu)) erreurs.push('le lieu est vide');
  if (net(p.grandPere) && !net(p.pere)) erreurs.push('un grand-père sans père (le lieu père est obligatoire avec un grand-père)');
  for (const [nom, valeur] of champs) {
    if (valeur.includes('--')) erreurs.push(`« ${nom} » contient « -- » (séparateur de la convention) : ${valeur}`);
    if (/["\\\/#+]/.test(valeur)) erreurs.push(`« ${nom} » contient un caractère interdit : ${valeur}`);
    if (/^-|-$/.test(valeur)) erreurs.push(`« ${nom} » commence ou finit par un tiret : ${valeur}`);
  }
  return erreurs;
}

/** Lit un nom existant (précis absent = lieu) ; null si le nom ne suit pas la convention. */
export function lireNom(nom: string): PartiesNom | null {
  const i = nom.indexOf('---');
  if (i < 0) return null;
  const quoi = nom.slice(0, i).trim();
  const segments = nom.slice(i + 3).split('--').map((s) => s.trim()).filter(Boolean);
  if (!quoi || segments.length === 0) return null;
  if (segments.length === 1) return { quoi, lieu: segments[0] };
  return { quoi, lieuPrecis: segments[0], lieu: segments[1], pere: segments[2], grandPere: segments[3] };
}
