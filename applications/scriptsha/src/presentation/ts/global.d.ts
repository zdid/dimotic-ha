declare global {
  interface Window {
    Alpine: any;
    // Connexion Socket.io unique du core (applications/core/src/presentation/ui/ts/app.ts),
    // réutilisée par ce dashboard au lieu d'en ouvrir une seconde — voir app.ts.
    app: { socketService: { getSocket(): any; connect(): any; on(event: string, cb: (...args: any[]) => void): void; emit(event: string, data?: any): void; isConnected(): boolean } };
  }
}

export {};
