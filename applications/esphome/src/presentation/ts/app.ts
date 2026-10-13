/**
 * Page d'état de l'application ESPHome (squelette) — reçoit `esphome:status` et l'affiche.
 */

interface DemandeVue { site: string; appareil: string; revision: number; action: string; etat: string; essais: number }
interface PoseVue { appareil: string; revision: number; esp: string; etat: string; essais: number }
interface EsphomeStatus {
  site: string;
  adresseJoignable: string;
  usine: { actif: boolean; sitesServis: string[]; enRetrait: string | null; connexions: { site: string; connecte: boolean }[]; demandes: DemandeVue[]; appareils: { appareil: string; modele: string; mac?: string }[] };
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

let appareilsConnus: { appareil: string; modele: string; mac?: string }[] = [];

function render(status: EsphomeStatus): void {
  appareilsConnus = status.usine.appareils;
  majFlash();
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

function majFlash(): void {
  const zone = moduleRoot().querySelector('#carte-flash') as HTMLElement | null;
  if (!zone) return;
  if (appareilsConnus.length === 0) { zone.innerHTML = '<p class="note">Aucun appareil connu : le premier paquet reçu de l\'assembleur crée l\'appareil et son modèle.</p>'; return; }
  const choix = (zone.querySelector('select') as HTMLSelectElement | null)?.value;
  zone.innerHTML = `<label class="label">Flasher la carte branchée comme appareil</label>
    <select id="flash-appareil" style="padding:6px;margin-right:8px">${appareilsConnus.map((a) => `<option value="${esc(a.appareil)}"${a.appareil === choix ? ' selected' : ''}>${esc(a.appareil)} (${esc(a.modele)}${a.mac ? ', déjà flashé' : ''})</option>`).join('')}</select>
    <button class="btn" id="btn-flasher" style="padding:8px 16px;cursor:pointer">Flasher par USB</button>
    <p class="note">La carte est reconnue d'abord ; si elle n'est pas du modèle de l'appareil, rien n'est écrit.</p>
    <div id="flash-resultat"></div>`;
  zone.querySelector('#btn-flasher')?.addEventListener('click', () => {
    const nom = (zone.querySelector('#flash-appareil') as HTMLSelectElement).value;
    if (!window.confirm(`Flasher la carte branchée sur la machine de l'usine comme « ${nom} » ? Son contenu actuel sera remplacé.`)) return;
    (zone.querySelector('#flash-resultat') as HTMLElement).innerHTML = '<p class="note">Reconnaissance puis flash en cours (jusqu\'à plusieurs minutes)…</p>';
    window.app.socketService.getSocket().emit('esphome:carte:flasher', { appareil: nom });
  });
}

function init(): void {
  const socket = window.app.socketService.getSocket();
  socket.on('esphome:status', (status: EsphomeStatus) => render(status));
  socket.on('esphome:carte:releve', (r: { releve: any; verdict: any }) => afficherCarte(r));
  socket.on('esphome:carte:flash', (r: { appareil: string; ok: boolean; raison?: string; releve?: { mac: string } }) => {
    const zone = moduleRoot().querySelector('#flash-resultat');
    if (zone) zone.innerHTML = r.ok ? `<p><strong>${esc(r.appareil)} flashé</strong> (MAC ${esc(r.releve?.mac ?? '')}). La carte redémarre sur le nouveau firmware.</p>` : `<p class="note">Refusé ou raté : ${esc(r.raison ?? '')}</p>`;
  });
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
