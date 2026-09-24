/**
 * Page de l'application de test du cycle de vie — affichage de l'état du process + saisie des
 * 3 données propres. Vit dans le Shadow DOM de ModuleContainer (voir sauvegarde/presentation/ts/
 * app.ts) : scoper les recherches sur `__moduleContainerRoot`, et ne poser les écouteurs socket
 * qu'une fois (init() est rappelée à chaque réaffichage).
 */

function moduleRoot(): ParentNode {
  return (window as any).__moduleContainerRoot || document;
}

function $<T extends HTMLElement>(id: string): T | null {
  return moduleRoot().querySelector(`#${id}`) as T | null;
}

interface TestcycleStatus {
  pid: number;
  startedAt: string;
  uptimeSec: number;
  crashMode: string;
  bridgeInstance: string;
  mqttConnected: boolean;
  haEntity: string;
  haState: string | null;
  haError: string | null;
  compteur: number;
  publicationActive: boolean;
  lastPublishAt: string | null;
}

interface TestcycleDonnees {
  message: string;
  valeurDepart: number;
  publicationActive: boolean;
}

let socket: any = null;
let listenersReady = false;

function setText(id: string, text: string, cls = ''): void {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = `value ${cls}`;
}

function onStatus(s: TestcycleStatus): void {
  setText('tc-pid', String(s.pid));
  setText('tc-uptime', `${new Date(s.startedAt).toLocaleTimeString()} / ${s.uptimeSec} s`);
  setText('tc-crash', s.crashMode, s.crashMode === 'aucun' ? '' : 'ko');
  setText('tc-mqtt', s.mqttConnected ? 'connecté' : 'déconnecté', s.mqttConnected ? 'ok' : 'ko');
  setText('tc-ha', s.haError ? `${s.haEntity} : ${s.haError}` : `${s.haEntity} = ${s.haState}`, s.haError ? 'ko' : 'ok');
  setText('tc-compteur', `${s.compteur}${s.publicationActive ? '' : ' (publication arrêtée)'}`);
  setText('tc-last', s.lastPublishAt ? new Date(s.lastPublishAt).toLocaleTimeString() : '—');
  setText('tc-bridge', s.bridgeInstance);
  const fresh = $('tc-fresh');
  if (fresh) fresh.textContent = `(reçu à ${new Date().toLocaleTimeString()})`;
}

function onDonnees(d: TestcycleDonnees): void {
  const message = $<HTMLInputElement>('tc-message');
  const depart = $<HTMLInputElement>('tc-depart');
  const actif = $<HTMLInputElement>('tc-actif');
  if (message) message.value = d.message;
  if (depart) depart.value = String(d.valeurDepart);
  if (actif) actif.checked = d.publicationActive;
}

function save(): void {
  socket.emit('testcycle:donnees:save', {
    message: $<HTMLInputElement>('tc-message')?.value ?? '',
    valeurDepart: Number($<HTMLInputElement>('tc-depart')?.value ?? 0),
    publicationActive: Boolean($<HTMLInputElement>('tc-actif')?.checked)
  });
}

function onSaveResult(r: { success: boolean; error?: string }): void {
  const el = $('tc-save-msg');
  if (el) el.textContent = r.success ? ' Enregistré.' : ` Erreur : ${r.error}`;
}

function init(): void {
  socket = window.app.socketService.getSocket();
  if (!listenersReady) {
    socket.on('testcycle:status', onStatus);
    socket.on('testcycle:donnees', onDonnees);
    socket.on('testcycle:donnees:save:result', onSaveResult);
    listenersReady = true;
  }
  // Selon le réaffichage (DOM recréé ou réutilisé), le bouton peut déjà avoir son écouteur :
  // marqueur sur l'élément lui-même pour ne jamais le poser deux fois.
  const button = $('tc-save');
  if (button && !button.dataset.bound) {
    button.addEventListener('click', save);
    button.dataset.bound = '1';
  }
  socket.emit('testcycle:status:get');
  socket.emit('testcycle:donnees:get');
}

declare global {
  interface Window {
    testcycleApp: { init: () => void };
  }
}

window.testcycleApp = { init };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

export {};
