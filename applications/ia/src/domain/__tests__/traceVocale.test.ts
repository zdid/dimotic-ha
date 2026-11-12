import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPONSE_TEXTE_NON_COMPRIS } from '../reponseVocale';
import { nouvelleTrace, questionSuspecte, actionDepuisReponse, etatsAttendus, verdict, aVerifier, JournalTraces, jourLocal } from '../traceVocale';

describe('trace vocale (specs v1.40 §16.15)', () => {
  it('cas du 12/11 15 h 42 : texte en arabe, réponse impérative sans outil → suspect + reponse_sans_action', () => {
    const t = nouvelleTrace('أدوم لقلون خبايل', true);
    t.chemin = 'mistral';
    t.reponse = 'Allume la lumière de la cuisine.';
    expect(t.questionSuspecte).toBe(true);
    expect(verdict(t)).toBe('reponse_sans_action');
  });
  it('réponse au texte suspect : finit par « ? » (HA garde le micro ouvert), sans verbe d\'action', () => {
    expect(REPONSE_TEXTE_NON_COMPRIS.trim().endsWith('?')).toBe(true);
    const t = nouvelleTrace('أدوم لقلون خبايل', true);
    t.chemin = 'texte_suspect'; t.reponse = REPONSE_TEXTE_NON_COMPRIS;
    expect(verdict(t)).toBe('sans_action');
  });
  it('texte français non suspect, texte vide suspect', () => {
    expect(questionSuspecte('Ok, Nagou ?')).toBe(false);
    expect(questionSuspecte('Allume le plan de travail.')).toBe(false);
    expect(questionSuspecte('')).toBe(true);
    expect(questionSuspecte('  … ? ')).toBe(true);
  });
  it('lecture d\'état (outil appelé) : pas de reponse_sans_action malgré « éteinte »', () => {
    const t = nouvelleTrace('la lumière de la chambre ?', true);
    t.outils.push({ tour: 1, nom: 'obtenir_etat', arguments: {}, resultat: '{}' });
    t.reponse = 'La lumière de la chambre du bas est éteinte.';
    expect(verdict(t)).toBe('sans_action');
  });
  it('cible lue dans le message du planificateur', () => {
    const a = actionDepuisReponse({ verbe: 'allumer' }, { success: true, message: 'homeassistant.turn_on exécuté sur light.a, light.b_2.' });
    expect(a).toMatchObject({ domaine: 'homeassistant', service: 'turn_on', entites: ['light.a', 'light.b_2'] });
    expect(actionDepuisReponse({}, { success: false, message: 'Commande non exécutée — quoi introuvable' }).entites).toEqual([]);
  });
  it('états attendus', () => {
    expect(etatsAttendus('turn_off')).toEqual(['off']);
    expect(etatsAttendus('close_cover')).toEqual(['closed', 'closing']);
    expect(etatsAttendus('toggle')).toEqual([]);
  });
  it('verdicts avec actions', () => {
    const t = nouvelleTrace('allume la cuisine', true);
    t.actions.push(actionDepuisReponse({}, { success: true, message: 'light.turn_on exécuté sur light.cuisine.' }));
    t.verification = aVerifier(t);
    expect(t.verification).toEqual([{ entity_id: 'light.cuisine', attendu: ['on'] }]);
    t.verification[0].constate = 'off'; t.verification[0].conforme = false;
    expect(verdict(t)).toBe('action_non_constatee');
    t.verification[0].constate = 'on'; t.verification[0].conforme = true;
    expect(verdict(t)).toBe('action_verifiee');
    t.actions.push(actionDepuisReponse({}, { success: false, message: 'planificateur ne répond pas' }));
    expect(verdict(t)).toBe('action_en_echec');
    t.erreur = 'Erreur API Mistral 500';
    expect(verdict(t)).toBe('erreur');
  });
  it('journal : écriture, lecture (récentes d\'abord, filtres), purge', () => {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'traces-'));
    const j = new JournalTraces(dossier);
    const t1 = nouvelleTrace('allume le salon', true); t1.reponse = 'J\'ai allumé le salon.'; t1.verdict = 'action_verifiee';
    const t2 = nouvelleTrace('أدوم', true); t2.reponse = 'Allume la cuisine.'; t2.verdict = 'reponse_sans_action';
    j.ecrire(t1); j.ecrire(t2);
    const tout = j.lire();
    expect(tout.total).toBe(2);
    expect(tout.traces[0].question).toBe('أدوم');
    expect(j.lire({ anomalies: true }).traces.map((t) => t.question)).toEqual(['أدوم']);
    expect(j.lire({ texte: 'salon' }).total).toBe(1);
    fs.writeFileSync(path.join(dossier, '2000-01-01.jsonl'), '{}\n');
    expect(j.purger(90)).toBe(1);
    expect(fs.existsSync(path.join(dossier, `${jourLocal(new Date())}.jsonl`))).toBe(true);
    fs.rmSync(dossier, { recursive: true, force: true });
  });
});
