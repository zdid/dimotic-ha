'use strict';
// Remplace « core/dist/exports » pour le générateur de script de l'application Sauvegarde (seul shellQuote est utilisé).
// Même définition que applications/core/src/infrastructure/remote/SshClient.ts.
exports.shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
