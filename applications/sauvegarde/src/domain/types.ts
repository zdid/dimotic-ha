export interface SauvegardeTargetSummary {
  id: string;
  site: string;
  machine: string;
  host: string;
}

export interface GossipImportResult {
  success: boolean;
  addedCount: number;
  error?: string;
}

export interface SauvegardeStatus {
  nextcloudConfigured: boolean;
  // URL WebDAV complète reconstruite (serverUrl + user), affichée sur le tableau de bord comme
  // aperçu — jamais saisie à la main (voir la remarque utilisateur du 17/09 sur le champ `user`
  // redondant). Vide tant que serverUrl/user ne sont pas tous les deux renseignés.
  webdavUrl: string;
  targetsCount: number;
  targets: SauvegardeTargetSummary[];
}
