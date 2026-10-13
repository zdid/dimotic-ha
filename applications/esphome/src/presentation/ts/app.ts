/**
 * Page d'état de l'application ESPHome (squelette) — reçoit `esphome:status` et l'affiche.
 */

interface EsphomeStatus {
  site: string;
  adresseJoignable: string;
  usine: { actif: boolean; sitesServis: string[] };
  poseur: { actif: boolean };
  implementation: string;
}

function moduleRoot(): ParentNode {
  return (window as any).__moduleContainerRoot || document;
}

function badge(actif: boolean): string {
  return `<span class="badge ${actif ? 'on' : 'off'}">${actif ? 'actif' : 'inactif'}</span>`;
}

function esc(texte: string): string {
  return texte.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function render(status: EsphomeStatus): void {
  const zone = moduleRoot().querySelector('#statut');
  if (!zone) return;
  zone.innerHTML = `<h2>État</h2>
    <div class="grid">
      <div><span class="label">Site</span><span class="value">${esc(status.site)}</span></div>
      <div><span class="label">Adresse joignable</span><span class="value">${esc(status.adresseJoignable || 'adresse locale')}</span></div>
      <div><span class="label">Usine</span><span class="value">${badge(status.usine.actif)}</span></div>
      <div><span class="label">Sites servis</span><span class="value">${status.usine.sitesServis.map(esc).join(', ') || '—'}</span></div>
      <div><span class="label">Poseur</span><span class="value">${badge(status.poseur.actif)}</span></div>
    </div>`;
}

function init(): void {
  const socket = window.app.socketService.getSocket();
  socket.on('esphome:status', (status: EsphomeStatus) => render(status));
  socket.emit('esphome:status:get');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

export {};
