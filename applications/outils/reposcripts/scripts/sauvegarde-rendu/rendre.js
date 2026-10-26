#!/usr/bin/env node
'use strict';
// Rend nextcloud-backup.sh avec le VRAI générateur de l'application Sauvegarde (renderBackupScript), pour que la machine préparée par
// Outils ait exactement le script que « Pousser » y déposerait. Usage : node rendre.js <site> <machine> <urlNextcloud> <utilisateur> <dossier> <fichierSecret>
// Le script écrit sur la sortie standard ; le mot de passe n'y figure jamais (il est lu dans le fichier secret).
const fs = require('fs');
const path = require('path');
const Module = require('module');

// BackupScript.js appelle require('../../../core/dist/exports') : on le remplace par le shim (seul shellQuote est utilisé).
const shim = path.join(__dirname, 'shim-exports.js');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (/core\/dist\/exports$/.test(request)) return shim;
  return resolve.call(this, request, ...rest);
};

// Dans l'archive Outils : BackupScript.js est à côté ; dans un clone du dépôt : application Sauvegarde compilée.
const candidats = [
  path.join(__dirname, 'BackupScript.js'),
  path.join(__dirname, '..', '..', '..', '..', 'sauvegarde', 'dist', 'domain', 'BackupScript.js')
];
const fichier = candidats.find((c) => fs.existsSync(c));
if (!fichier) { console.error('ERREUR : générateur de script de sauvegarde introuvable (application Sauvegarde non compilée ?)'); process.exit(1); }
const { renderBackupScript } = require(fichier);

const [site, machine, serverUrl, user, rootPath, secretFilePath] = process.argv.slice(2);
if (![site, machine, serverUrl, user, rootPath, secretFilePath].every(Boolean)) {
  console.error('Usage : node rendre.js <site> <machine> <urlNextcloud> <utilisateur> <dossier> <fichierSecret>');
  process.exit(1);
}
process.stdout.write(renderBackupScript({ site, machine, serverUrl, user, rootPath, secretFilePath }));
