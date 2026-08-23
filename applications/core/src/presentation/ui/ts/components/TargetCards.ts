/**
 * TargetCards — rendu mutualisé d'une liste de cibles distantes (rpigpio/teleinfo/arexx, ⭐
 * 23/08/2026) : une carte par cible, avec les instructions de préparation SSH (ssh-keygen +
 * ssh-copy-id, adaptées si l'instance tourne dans un conteneur Docker) et 4 boutons
 * (Déployer/Démarrer/Arrêter/Redémarrer). Servi en `/js/ts/components/TargetCards.js` (voir
 * core/src/presentation/ui/tsconfig.ui.json), consommé via ce chemin par les 3 apps.
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
  /** Identifiant de l'application (ex: "rpigpio") — utilisé pour le chemin de clé SSH affiché. */
  appId: string;
  targets: TargetSummary[];
  isRunningInDocker: boolean;
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
  const { appId, targets, isRunningInDocker, onAction, onDelete } = options;

  if (targets.length === 0) {
    container.innerHTML = '<div class="empty">Aucune cible configurée — ajouter une cible dans les paramètres de l\'application.</div>';
    return;
  }

  container.innerHTML = targets.map((target) => {
    const keyPath = `data/${appId}/ssh/${escapeHtml(target.id)}/id_ed25519`;
    const hostLabel = escapeHtml(target.host || '<hôte>');
    const dockerHint = isRunningInDocker
      ? `<div class="target-docker-hint">⚠️ Cette instance tourne dans un conteneur Docker — la clé générée doit être lisible par ce conteneur. Ouvrir d'abord un terminal <strong>dans</strong> le conteneur :<pre>docker exec -it &lt;nom du conteneur&gt; bash</pre></div>`
      : '';

    const deleteButton = onDelete ? `<button type="button" class="target-delete" data-delete="1">🗑️ Supprimer</button>` : '';

    return `
      <div class="target-card" data-target-id="${escapeHtml(target.id)}">
        <h4>${escapeHtml(target.id)} <span class="target-host">(${escapeHtml(target.host || '—')})</span></h4>
        ${deleteButton}
        <details class="target-ssh-prep">
          <summary>Préparer l'accès SSH (une fois par cible)</summary>
          ${dockerHint}
          <pre>ssh-keygen -t ed25519 -f ${keyPath} -N "" -q
ssh-copy-id -i ${keyPath}.pub root@${hostLabel}</pre>
        </details>
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
