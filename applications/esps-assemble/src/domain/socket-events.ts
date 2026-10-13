/** Événements Socket.io de l'application ESPS-ASSEMBLE — préfixe `esps-assemble:`. */

export const ASSEMBLEUR_SOCKET_EVENTS = {
  APPAREILS: 'esps-assemble:appareils',
  RESULTAT: 'esps-assemble:assemblage:resultat',
  ERROR: 'esps-assemble:error'
} as const;

export const ASSEMBLEUR_CLIENT_EVENTS = {
  GET_APPAREILS: 'esps-assemble:appareils:get',
  ASSEMBLER: 'esps-assemble:assembler',
  ANNULER: 'esps-assemble:annuler'
} as const;

export const ASSEMBLEUR_ALL_EVENTS = { ...ASSEMBLEUR_SOCKET_EVENTS, ...ASSEMBLEUR_CLIENT_EVENTS } as const;

export const ASSEMBLEUR_PERSISTENT_EVENTS: string[] = [ASSEMBLEUR_SOCKET_EVENTS.APPAREILS];
