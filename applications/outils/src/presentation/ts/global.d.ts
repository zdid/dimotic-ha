// Voir le commentaire équivalent dans sauvegarde/presentation/ts/global.d.ts : window.Alpine et
// window.app.socketService existent déjà quand ce module s'exécute, injectés par le core.
declare global {
  interface Window {
    Alpine: any;
    app: {
      socketService: { getSocket(): any; connect(): any; on(event: string, cb: (...args: any[]) => void): void; emit(event: string, data?: any): void; isConnected(): boolean };
      /** ⭐ 25/09/2026 — machines du gossip, gardées par la page principale (core app.ts). */
      remoteApps?: Array<{ machineId: string; address?: string; runningInDocker?: boolean }>;
    };
  }
}

export {};
