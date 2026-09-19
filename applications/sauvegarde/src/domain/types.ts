export interface GossipImportResult {
  success: boolean;
  addedCount: number;
  error?: string;
}

// ⭐ 17/09/2026 — plus de `targets: SauvegardeTargetSummary[]` ici : la liste des machines (édition,
// import gossip, poussée du secret) vit entièrement sur Paramètres Techniques (moduleConfigs côté
// navigateur), le tableau de bord n'a plus besoin d'en recevoir une copie séparée.
export interface SauvegardeStatus {
  nextcloudConfigured: boolean;
  // URL WebDAV complète reconstruite (serverUrl + user), affichée sur le tableau de bord ET sur
  // Paramètres Techniques (aperçu 'preview' en direct) — jamais saisie à la main. Vide tant que
  // serverUrl/user ne sont pas tous les deux renseignés.
  webdavUrl: string;
  targetsCount: number;
}
