/**
 * Script TypeScript pour la page Déploiement AREXX — affiche la commande à lancer sur la
 * machine cible, avec le port réellement configuré (arexx:status) déjà substitué.
 */

import { SocketService } from '/js/ts/services/SocketService.js';

let socket: any | null = null;

function init(): void {
  const socketService = new SocketService();
  socket = socketService.connect();

  socket.on('arexx:status', (status: { httpservPort: number }) => {
    const el = document.getElementById('port-value');
    if (el) el.textContent = String(status.httpservPort);
    hideLoading();
  });

  socket.emit('arexx:status:get');

  document.getElementById('btn-copy')?.addEventListener('click', () => {
    const text = document.getElementById('deploy-command')?.textContent ?? '';
    navigator.clipboard.writeText(text.trim());
  });
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
