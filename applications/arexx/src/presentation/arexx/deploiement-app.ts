/**
 * Script TypeScript pour la page Déploiement AREXX — pré-remplit et enregistre l'adresse du
 * récepteur (data/arexx/drivers/target.txt) via un formulaire, plutôt qu'une édition manuelle du
 * fichier.
 */

import { SocketService } from '/js/ts/services/SocketService.js';
import { renderTargetCards, renderSshPrepSection, showTargetActionResult, type TargetActionResult, type RemoteAction } from '/js/ts/components/TargetCards.js';

let socket: any | null = null;
/** Distingue le chargement initial (pré-remplissage silencieux) de l'enregistrement explicite
 *  (confirmation affichée) — les deux réutilisent le même événement serveur en retour. */
let saving = false;

function init(): void {
  const socketService = new SocketService();
  socket = socketService.connect();

  socket.on('arexx:driver-target', (target: { host: string; port: number }) => {
    const hostEl = document.getElementById('input-host') as HTMLInputElement | null;
    const portEl = document.getElementById('input-port') as HTMLInputElement | null;
    if (hostEl && !hostEl.value) hostEl.value = target.host;
    if (portEl) portEl.value = String(target.port);
    hideLoading();
    if (saving) {
      saving = false;
      showAlert('Enregistré', 'success');
    }
  });

  socket.on('arexx:status', (status: { isRunningInDocker: boolean; projectRoot: string; targets: { id: string; host: string }[] }) => {
    const sshPrepContainer = document.getElementById('ssh-prep-container');
    if (sshPrepContainer) {
      renderSshPrepSection(sshPrepContainer, { isRunningInDocker: status.isRunningInDocker, projectRoot: status.projectRoot });
    }
    const container = document.getElementById('targets-container');
    if (container) {
      renderTargetCards(container, {
        targets: status.targets,
        onAction: (targetId: string, action: RemoteAction) => {
          socket.emit('arexx:remote-op', { targetId, action });
        }
      });
    }
  });
  socket.emit('arexx:status:get');

  socket.on('arexx:remote-op:result', (result: TargetActionResult) => {
    const container = document.getElementById('targets-container');
    if (container) showTargetActionResult(container, result);
  });

  socket.on('arexx:error', (error: { message: string }) => {
    saving = false;
    showAlert(error.message, 'error');
  });

  socket.emit('arexx:driver-target:get');

  document.getElementById('btn-save')?.addEventListener('click', () => {
    const host = (document.getElementById('input-host') as HTMLInputElement | null)?.value.trim() ?? '';
    const port = Number((document.getElementById('input-port') as HTMLInputElement | null)?.value ?? '');
    if (!host) {
      showAlert('Adresse IP manquante', 'error');
      return;
    }
    saving = true;
    socket.emit('arexx:driver-target:save', { host, port });
  });
}

function showAlert(message: string, type: 'success' | 'error'): void {
  const successEl = document.getElementById('success-alert');
  const errorEl = document.getElementById('error-alert');
  [successEl, errorEl].forEach((el) => { if (el) el.style.display = 'none'; });

  const el = type === 'error' ? errorEl : successEl;
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  }
}

function hideLoading(): void {
  const el = document.getElementById('loading');
  if (el) el.style.display = 'none';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
