declare global {
  interface Window {
    app: { socketService: { getSocket(): any } };
    screen2httpApp?: { init(): void };
    Terminal?: any;
    FitAddon?: { FitAddon: new () => any };
  }
}

export {};
