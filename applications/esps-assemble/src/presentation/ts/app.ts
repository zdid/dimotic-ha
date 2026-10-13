/** Page de l'assembleur ESP : appareils, vérifications, assemblage (demande à l'usine), annulation, état publié par l'usine et le poseur. */

interface Ligne {
  nom: string; nomAffichage: string; materiel: string; etat: 'pret' | 'refuse'; erreurs: string[]; avertissements: string[];
  derniereRevision: number | null;
  statut: { etat: string; detail: string; revision: number; at: string } | null;
  demandeEnAttente: { revision: number; action: string } | null;
}
interface Etat { site: string; connecte: boolean; appareils: Ligne[] }

const racine = (): ParentNode => (window as any).__moduleContainerRoot || document;
const esc = (t: string): string => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const messages = new Map<string, string>();

const LIBELLES: Record<string, string> = {
  en_attente: 'en attente', recuperation: 'récupération du paquet', reconnaissance: 'reconnaissance', compilation: 'compilation en cours',
  pret_a_poser: 'firmware prêt', envoi: 'envoi à l\'ESP', verification: 'vérification', termine: 'terminé', echec: 'échec'
};

function rendre(e: Etat): void {
  const entete = racine().querySelector('#entete');
  if (entete) entete.textContent = `Site ${e.site} — ${e.connecte ? 'connecté au broker MQTT du site' : 'PAS de connexion au broker MQTT : assembler est impossible'}`;
  const zone = racine().querySelector('#liste');
  if (!zone) return;
  zone.innerHTML = e.appareils.map((a) => {
    const st = a.statut;
    const classeSt = !st ? 'neutre' : st.etat === 'termine' ? 'ok' : st.etat === 'echec' ? 'ko' : 'att';
    return `<div class="carte" data-appareil="${esc(a.nom)}">
      <h2>${esc(a.nomAffichage)} <span class="note">(${esc(a.nom)} — ${esc(a.materiel)})</span></h2>
      <div class="ligne">
        <span class="badge ${a.etat === 'pret' ? 'ok' : 'ko'}">${a.etat === 'pret' ? 'prêt à assembler' : 'refusé'}</span>
        <span>dernière révision : ${a.derniereRevision ?? '—'}</span>
        ${a.demandeEnAttente ? `<span class="badge att">demande en attente chez l'usine : r${a.demandeEnAttente.revision} (${esc(a.demandeEnAttente.action)})</span>` : ''}
        ${st ? `<span class="badge ${classeSt}">r${st.revision} : ${esc(LIBELLES[st.etat] ?? st.etat)}</span>` : '<span class="note">aucun état reçu</span>'}
      </div>
      ${a.erreurs.map((x) => `<div class="erreurs">✘ ${esc(x)}</div>`).join('')}
      ${a.avertissements.map((x) => `<div class="avert">⚠ ${esc(x)}</div>`).join('')}
      ${st && st.detail ? `<div class="msg note">${esc(st.detail.slice(-600))}</div>` : ''}
      <div style="margin-top:10px">
        <button class="btn" data-act="firmware" ${a.etat !== 'pret' || !e.connecte ? 'disabled' : ''}>Assembler et envoyer à l'usine</button>
        <button class="btn" data-act="amorce" ${a.etat !== 'pret' || !e.connecte ? 'disabled' : ''} title="Première carte : amorce à flasher par USB">Amorce (première carte)</button>
        <button class="btn" data-act="annuler" ${a.demandeEnAttente ? '' : 'disabled'}>Annuler la demande</button>
      </div>
      <div class="msg" data-msg>${esc(messages.get(a.nom) ?? '')}</div>
    </div>`;
  }).join('') || '<p class="note">Aucun appareil : ajoutez une fiche dans appareils/&lt;nom&gt;.fiche.yaml.</p>';
}

function init(): void {
  const socket = window.app.socketService.getSocket();
  socket.on('esps-assemble:appareils', (e: Etat) => rendre(e));
  socket.on('esps-assemble:assemblage:resultat', (r: { appareil: string; ok: boolean; revision?: number; action?: string; erreurs?: string[]; avertissements?: string[] }) => {
    messages.set(r.appareil, r.ok ? `✔ révision ${r.revision} (${r.action}) publiée : l'usine a été prévenue.` : `✘ ${(r.erreurs ?? []).join(' ; ')}`);
    socket.emit('esps-assemble:appareils:get');
  });
  socket.on('esps-assemble:error', (e: { message: string }) => { const h = racine().querySelector('#entete'); if (h) h.textContent = e.message; });
  racine().querySelector('#liste')?.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
    const c = (ev.target as HTMLElement).closest('.carte') as HTMLElement | null;
    if (!b || !c || b.disabled) return;
    const appareil = c.dataset.appareil as string;
    if (b.dataset.act === 'annuler') { socket.emit('esps-assemble:annuler', { appareil }); messages.set(appareil, 'Demande annulée.'); }
    else { socket.emit('esps-assemble:assembler', { appareil, action: b.dataset.act }); messages.set(appareil, 'Assemblage en cours…'); }
    const m = c.querySelector('[data-msg]'); if (m) m.textContent = messages.get(appareil) ?? '';
  });
  socket.emit('esps-assemble:appareils:get');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
export {};
