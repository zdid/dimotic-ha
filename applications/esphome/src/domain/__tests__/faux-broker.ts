import type { Transport } from '../bus';
import { correspond } from '../bus';

/** Faux broker MQTT en mémoire : messages conservés, filtres `+`/`#`, testament publié à la coupure brutale. */
export class FauxBroker {
  readonly conserves = new Map<string, string>();
  private readonly clients = new Set<FauxClient>();

  transport(will?: { topic: string; payload: string }): FauxClient {
    const c = new FauxClient(this, will);
    this.clients.add(c);
    return c;
  }

  publier(topic: string, payload: string, retain: boolean): void {
    if (retain) {
      if (payload === '') this.conserves.delete(topic);
      else this.conserves.set(topic, payload);
    }
    for (const c of this.clients) c.livrer(topic, payload, retain);
  }

  retire(c: FauxClient): void {
    this.clients.delete(c);
  }
}

export class FauxClient implements Transport {
  private connecte = false;
  private readonly filtres = new Set<string>();
  private msg: ((m: { topic: string; payload: Buffer | string; retain: boolean }) => void)[] = [];
  private conn: (() => void)[] = [];
  readonly publications: { topic: string; payload: string; retain: boolean }[] = [];

  constructor(private readonly broker: FauxBroker, private readonly will?: { topic: string; payload: string }) {}

  connect(): void {
    this.connecte = true;
    this.conn.forEach((cb) => cb());
  }
  disconnect(): void {
    this.connecte = false;
    this.broker.retire(this);
  }
  /** Coupure brutale : le broker publie le testament. */
  couper(): void {
    this.disconnect();
    if (this.will) this.broker.publier(this.will.topic, this.will.payload, true);
  }
  publish(topic: string, payload: string | Buffer, _qos = 0, retain = false): void {
    const p = payload.toString();
    this.publications.push({ topic, payload: p, retain });
    this.broker.publier(topic, p, retain);
  }
  subscribe(topic: string): void {
    this.filtres.add(topic);
    for (const [t, p] of this.broker.conserves) if (correspond(topic, t)) this.livrerA(t, p, true);
  }
  onMessage(cb: (m: { topic: string; payload: Buffer | string; retain: boolean }) => void): void {
    this.msg.push(cb);
  }
  onConnect(cb: () => void): void {
    this.conn.push(cb);
  }
  onDisconnect(): void {}
  getConnected(): boolean {
    return this.connecte;
  }
  livrer(topic: string, payload: string, retain: boolean): void {
    for (const f of this.filtres) if (correspond(f, topic)) return this.livrerA(topic, payload, retain);
  }
  private livrerA(topic: string, payload: string, retain: boolean): void {
    this.msg.forEach((cb) => cb({ topic, payload, retain }));
  }
}
