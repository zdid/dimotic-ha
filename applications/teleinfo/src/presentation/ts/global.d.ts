declare global {
  interface Window {
    Alpine: any;
    app: { socketService: { getSocket(): any; connect(): any; on(event: string, cb: (...args: any[]) => void): void; emit(event: string, data?: any): void; isConnected(): boolean } };
  }
}

export {};
