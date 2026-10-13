/**
 * Page d'état de l'application ESPHome (squelette) — reçoit `esphome:status` et l'affiche.
 */

interface DemandeVue { site: string; appareil: string; revision: number; action: string; etat: string; essais: number }
interface PoseVue { appareil: string; revision: number; esp: string; etat: string; essais: number }
interface EsphomeStatus {
  site: string;
  adresseJoignable: string;
  usine: { actif: boolean; sitesServis: string[]; enRetrait: string | null; connexions: { site: string; connecte: boolean }[]; demandes: DemandeVue[] };
  poseur: { actif: boolean; enRetrait: string | null; connecte: boolean; poses: PoseVue[] };
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
    </div>
    ${status.usine.enRetrait ? `<p class="note">Usine en retrait — ${esc(status.usine.enRetrait)}</p>` : ''}
    ${status.poseur.enRetrait ? `<p class="note">Poseur en retrait — ${esc(status.poseur.enRetrait)}</p>` : ''}
    ${status.usine.connexions.length ? `<p class="note">Brokers : ${status.usine.connexions.map((c) => `${esc(c.site)} ${c.connecte ? '✔' : '✘'}`).join(', ')}</p>` : ''}
    ${status.usine.demandes.length ? `<h3>Demandes</h3>${status.usine.demandes.map((d) => `<div>${esc(d.appareil)} r${d.revision} (${esc(d.action)}, ${esc(d.site)}) — ${esc(d.etat)}${d.essais > 1 ? ` (essai ${d.essais})` : ''}</div>`).join('')}` : ''}
    ${status.poseur.poses.length ? `<h3>Poses</h3>${status.poseur.poses.map((p) => `<div>${esc(p.appareil)} r${p.revision} vers ${esc(p.esp)} — ${esc(p.etat)}${p.essais > 1 ? ` (essai ${p.essais})` : ''}</div>`).join('')}` : ''}`;
}

const VERDICTS: Record<string, string> = {
  appareil_connu: 'appareil déjà enregistré',
  nouvel_exemplaire: "nouvel exemplaire d'un modèle connu",
  carte_inconnue: 'carte inconnue : aucun modèle ne correspond (créer le modèle puis l\'appareil)',
  non_conforme: 'carte non conforme au modèle choisi'
};

function afficherCarte(r: { releve: any; verdict: any }): void {
  const zone = moduleRoot().querySelector('#carte-resultat');
  if (!zone) return;
  const { releve, verdict } = r;
  zone.innerHTML = `<div class="grid">
      <div><span class="label">Puce</span><span class="value">${esc(releve.puceBrute)}</span></div>
      <div><span class="label">Flash</span><span class="value">${esc(releve.flash ?? 'non relevée')}</span></div>
      <div><span class="label">MAC</span><span class="value">${esc(releve.mac)}</span></div></div>
    <p class="note">${esc(releve.fonctions.join(', '))}</p>
    <p><strong>${esc(VERDICTS[verdict.type] ?? verdict.type)}</strong>${verdict.detail ? ' — ' + esc(verdict.detail) : ''}</p>`;
}

function init(): void {
  const socket = window.app.socketService.getSocket();
  socket.on('esphome:status', (status: EsphomeStatus) => render(status));
  socket.on('esphome:carte:releve', (r: { releve: any; verdict: any }) => afficherCarte(r));
  socket.on('esphome:error', (e: { message: string }) => {
    const zone = moduleRoot().querySelector('#carte-resultat');
    if (zone) zone.innerHTML = `<p class="note">${esc(e.message)}</p>`;
  });
  moduleRoot().querySelector('#btn-carte')?.addEventListener('click', () => {
    const zone = moduleRoot().querySelector('#carte-resultat');
    if (zone) zone.innerHTML = '<p class="note">Lecture de la carte…</p>';
    socket.emit('esphome:carte:reconnaitre');
  });
  socket.emit('esphome:status:get');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

export {};
