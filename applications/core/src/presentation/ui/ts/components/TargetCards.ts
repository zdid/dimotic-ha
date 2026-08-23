/**
 * TargetCards — rendu mutualisé d'une liste de cibles distantes (rpigpio/teleinfo/arexx/core, ⭐
 * 23/08/2026) : une carte par cible avec 4 boutons (Déployer/Démarrer/Arrêter/Redémarrer). Servi en
 * `/js/ts/components/TargetCards.js` (voir core/src/presentation/ui/tsconfig.ui.json), consommé
 * via ce chemin par les 3 apps ; utilisé en import relatif direct par `core` lui-même.
 *
 * L'instruction `ssh-copy-id` n'est plus répétée par carte (⭐ 24/08/2026) — une seule clé SSH pour
 * toute l'installation (voir `ensureGlobalSshKey`, core/infrastructure/remote/SshClient.ts), donc
 * une seule instruction suffit pour toute la page : voir `renderSshPrepSection` ci-dessous, à
 * appeler une fois avant la liste des cartes.
 *
 * Ne connaît rien de Socket.io ni de la façon dont chaque app obtient sa connexion (rpigpio/
 * teleinfo : dashboard Shadow DOM, `window.app.socketService` ; arexx : page autonome,
 * `SocketService` importée) — un simple callback `onAction` déclenche l'émission côté appelant.
 */

export type RemoteAction = 'deploy' | 'start' | 'stop' | 'restart';

export interface TargetSummary {
  id: string;
  host: string;
}

export interface TargetActionResult {
  targetId: string;
  action: RemoteAction;
  success: boolean;
  step?: string;
  error?: string;
  output?: string;
}

export interface RenderTargetCardsOptions {
  targets: TargetSummary[];
  onAction: (targetId: string, action: RemoteAction) => void;
  /** Optionnel — affiche un bouton "Supprimer" par carte s'il est fourni. Pas utilisé par
   *  rpigpio/teleinfo/arexx (suppression déjà possible via le formulaire générique `type:'array'`,
   *  §core/src/types/config.ts) ; utilisé par `core` (DeploymentManager.ts), qui n'a pas ce moteur
   *  générique pour sa propre config. */
  onDelete?: (targetId: string) => void;
}

const ACTION_LABELS: Record<RemoteAction, string> = {
  deploy: '🚀 Déployer',
  start: '▶️ Démarrer',
  stop: '⏹️ Arrêter',
  restart: '🔄 Redémarrer'
};

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function findCard(container: HTMLElement, targetId: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('.target-card'))
    .find((card) => card.dataset.targetId === targetId);
}

export function renderTargetCards(container: HTMLElement, options: RenderTargetCardsOptions): void {
  const { targets, onAction, onDelete } = options;

  if (targets.length === 0) {
    container.innerHTML = '<div class="empty">Aucune cible configurée — ajouter une cible dans les paramètres de l\'application.</div>';
    return;
  }

  container.innerHTML = targets.map((target) => {
    const deleteButton = onDelete ? `<button type="button" class="target-delete" data-delete="1">🗑️ Supprimer</button>` : '';

    return `
      <div class="target-card" data-target-id="${escapeHtml(target.id)}">
        <h4>${escapeHtml(target.id)} <span class="target-host">(${escapeHtml(target.host || '—')})</span></h4>
        ${deleteButton}
        <div class="target-actions">
          <button type="button" data-action="deploy">${ACTION_LABELS.deploy}</button>
          <button type="button" data-action="start">${ACTION_LABELS.start}</button>
          <button type="button" data-action="stop">${ACTION_LABELS.stop}</button>
          <button type="button" data-action="restart">${ACTION_LABELS.restart}</button>
        </div>
        <div class="target-result target-result-success" style="display:none;"></div>
        <div class="target-result target-result-error" style="display:none;"></div>
      </div>
    `;
  }).join('');

  container.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.target-card') as HTMLElement | null;
      const targetId = card?.dataset.targetId;
      const action = btn.dataset.action as RemoteAction | undefined;
      if (!targetId || !action) return;
      card?.querySelectorAll<HTMLElement>('.target-result').forEach((el) => { el.style.display = 'none'; });
      onAction(targetId, action);
    });
  });

  if (onDelete) {
    container.querySelectorAll<HTMLButtonElement>('button[data-delete]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.target-card') as HTMLElement | null;
        const targetId = card?.dataset.targetId;
        if (!targetId) return;
        onDelete(targetId);
      });
    });
  }
}

export interface RenderSshPrepSectionOptions {
  isRunningInDocker: boolean;
  /** Racine réelle du projet sur l'hôte (`process.env.PROJECT_ROOT`), utilisée pour le `cd`
   *  préalable à `ssh-copy-id` hors Docker. */
  projectRoot: string;
}

/**
 * Section unique, affichée une fois en tête de page (⭐ 24/08/2026) — explique comment autoriser la
 * clé SSH (désormais unique pour toute l'installation, voir `ensureGlobalSshKey`,
 * core/infrastructure/remote/SshClient.ts) sur une nouvelle cible. Remplace le bloc "Copier la
 * clé" auparavant répété identique sur chaque carte (seul l'hôte variait) — l'hôte reste à
 * remplacer manuellement ici, un seul modèle de commande couvre toutes les cibles.
 */
export function renderSshPrepSection(container: HTMLElement, options: RenderSshPrepSectionOptions): void {
  const { isRunningInDocker, projectRoot } = options;

  const dockerHint = isRunningInDocker
    ? `<div class="target-docker-hint">⚠️ Cette instance tourne dans un conteneur Docker — la clé (déjà générée automatiquement) doit être lisible par ce conteneur. Ouvrir d'abord un terminal <strong>dans</strong> le conteneur :<pre>docker exec -it &lt;nom du conteneur&gt; bash</pre></div>`
    : '';
  const cdCommand = isRunningInDocker ? 'cd /app' : `cd ${escapeHtml(projectRoot)}`;

  container.innerHTML = `
    <div class="ssh-prep-section">
      <p>Une seule clé SSH est générée automatiquement au démarrage, partagée par toutes les applications et toutes les cibles. Avant le premier déploiement vers une nouvelle machine, y copier la clé publique (une fois par machine) :</p>
      ${dockerHint}
      <pre>${cdCommand}
ssh-copy-id -i data/core/ssh/id_ed25519.pub root@&lt;hôte-de-la-cible&gt;</pre>
    </div>
  `;
}

export function showTargetActionResult(container: HTMLElement, result: TargetActionResult): void {
  const card = findCard(container, result.targetId);
  if (!card) return;

  const successEl = card.querySelector<HTMLElement>('.target-result-success');
  const errorEl = card.querySelector<HTMLElement>('.target-result-error');

  if (result.success) {
    if (successEl) {
      successEl.textContent = `${ACTION_LABELS[result.action]} : réussi${result.output ? ` (${result.output})` : ''}.`;
      successEl.style.display = 'block';
    }
    if (errorEl) errorEl.style.display = 'none';
  } else {
    if (errorEl) {
      errorEl.textContent = `${ACTION_LABELS[result.action]} : échec${result.step ? ` (${result.step})` : ''} — ${result.error || 'erreur inconnue'}`;
      errorEl.style.display = 'block';
    }
    if (successEl) successEl.style.display = 'none';
  }
}
