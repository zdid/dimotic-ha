// Voir le commentaire équivalent dans sauvegarde/presentation/ts/global.d.ts : window.Alpine et
// window.app.socketService existent déjà quand ce module s'exécute, injectés par le core.
declare global {
  interface Window {
    Alpine: any;
    app: { socketService: { getSocket(): any; connect(): any; on(event: string, cb: (...args: any[]) => void): void; emit(event: string, data?: any): void; isConnected(): boolean } };
  }
}

export {};
