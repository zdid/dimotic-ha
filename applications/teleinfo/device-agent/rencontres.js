/**
 * Journal des compteurs rencontrés au démarrage de l'agent : une ligne la PREMIÈRE fois qu'un ADCO est lu (déclaré ou
 * non), puis un récapitulatif après le premier cycle complet (2 lectures). Ensuite plus rien (pas un message par trame).
 */
'use strict';

const LECTURES_PAR_CYCLE = 2;

/**
 * @param {object} options
 * @param {() => Array<{adco:number, quoi?:string, lieu?:string, lieuPrecis?:string}>} options.declares compteurs de config.yaml
 * @param {(msg: string) => void} options.journal
 */
function createRencontres(options) {
  const rencontres = new Set();
  let lectures = 0;
  let recapFait = false;

  function nom(adco) {
    const c = options.declares().find((x) => Number(x.adco) === adco);
    if (!c) return 'NON déclaré dans config.yaml';
    return 'déclaré : ' + [c.quoi, c.lieuPrecis, c.lieu].filter(Boolean).join(' / ');
  }

  function compter() {
    lectures++;
    if (recapFait || lectures < LECTURES_PAR_CYCLE) return;
    recapFait = true;
    const declares = options.declares().map((c) => Number(c.adco));
    const manquants = declares.filter((a) => !rencontres.has(a));
    const liste = [...rencontres].join(', ') || 'aucun';
    options.journal(
      'Compteurs rencontrés au démarrage : ' + rencontres.size + ' (ADCO ' + liste + ')' +
        (manquants.length ? ' — déclaré(s) mais pas encore vu(s) : ' + manquants.join(', ') : '')
    );
  }

  return {
    /** Une trame valide vient d'être lue. */
    trame(adco) {
      const n = Number(adco);
      if (!rencontres.has(n)) {
        rencontres.add(n);
        options.journal('Compteur rencontré : ADCO ' + n + ' (' + nom(n) + ')');
      }
      compter();
    },
    /** Une lecture a échoué. */
    erreur() {
      compter();
    }
  };
}

module.exports = { createRencontres };
