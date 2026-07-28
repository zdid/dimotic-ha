// src/infrastructure/auth/AuthService.ts
// Porte d'authentification OAuth2 HA pour l'accès externe — voir décision "accès externe"
// (conception 2026-07-28) et techniques-socle-ha-mqtt_specs.
//
// Sert UNIQUEMENT de portail de connexion (identifiant/mot de passe HA, MFA compris) : une
// fois authentifié, tous les utilisateurs partagent le même accès complet via le jeton longue
// durée déjà utilisé par le serveur pour piloter HA (ha.ws.token) — pas de permissions
// différenciées par utilisateur HA, choix explicitement tranché. Ce service ne conserve donc ni
// le token HA obtenu à l'échange, ni l'identité de l'utilisateur — seule la réussite de
// l'échange serveur-à-serveur (POST /auth/token) fait foi.
//
// Cookie de session : signé HMAC-SHA256 (crypto natif de Node), sans état côté serveur — pas de
// nouvelle dépendance npm (pas de express-session/jsonwebtoken/cookie-parser). Le header Cookie
// HTTP est trivial à parser soi-même (parseCookies ci-dessous).
//
// Flux vérifié contre developers.home-assistant.io/docs/auth_api (2026-07-28) : GET
// /auth/authorize (client_id + redirect_uri, PAS de response_type, validation "IndieAuth" par
// correspondance de domaine, aucun enregistrement préalable requis) → redirection avec
// ?code&state → POST /auth/token (grant_type=authorization_code, code, client_id) → {access_token,
// refresh_token, expires_in, token_type}.

import * as crypto from 'node:crypto';
import type { AuthConfig } from '../../types/config';
import type { Logger } from '../logger/index';

const SESSION_COOKIE = 'ws_ha_session';
const STATE_COOKIE = 'ws_ha_oauth_state';
const REDIRECT_COOKIE = 'ws_ha_oauth_redirect';

interface SessionPayload {
  exp: number; // epoch ms
}

export class AuthService {
  private readonly config: AuthConfig;
  private readonly logger: Logger;

  constructor(config: AuthConfig | undefined, logger: Logger) {
    this.config = config ?? {
      enabled: false,
      ha_base_url: '',
      client_id: '',
      redirect_uri: '',
      session_secret: '',
      session_ttl_hours: 720,
    };
    this.logger = logger;

    if (this.config.enabled && !this.config.session_secret) {
      throw new Error(
        "AuthService: web.auth.enabled=true nécessite web.auth.session_secret (échec au démarrage plutôt qu'un mode dégradé silencieux)."
      );
    }
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  // ==========================================================================
  // Cookies — noms exposés pour que PresentationServer pose/efface les bons cookies
  // ==========================================================================

  get sessionCookieName(): string {
    return SESSION_COOKIE;
  }

  get stateCookieName(): string {
    return STATE_COOKIE;
  }

  get redirectCookieName(): string {
    return REDIRECT_COOKIE;
  }

  /** Parseur minimal du header Cookie — pas de dépendance cookie-parser pour un besoin aussi simple. */
  static parseCookies(header?: string): Record<string, string> {
    const result: Record<string, string> = {};
    if (!header) return result;
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (key) result[key] = decodeURIComponent(value);
    }
    return result;
  }

  // ==========================================================================
  // Flux OAuth2
  // ==========================================================================

  generateState(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  buildAuthorizeUrl(state: string): string {
    const url = new URL('/auth/authorize', this.config.ha_base_url);
    url.searchParams.set('client_id', this.config.client_id);
    url.searchParams.set('redirect_uri', this.config.redirect_uri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  /**
   * Échange le code d'autorisation contre un token — cet appel serveur-à-serveur EST la preuve
   * d'authentification (un `code` reçu en paramètre de /auth/callback n'est jamais suffisant à
   * lui seul : il pourrait être rejoué/forgé, seul HA peut confirmer sa validité). Le token
   * obtenu n'est pas conservé, voir en-tête de fichier.
   */
  async exchangeCodeForToken(code: string): Promise<boolean> {
    try {
      const response = await fetch(new URL('/auth/token', this.config.ha_base_url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: this.config.client_id,
        }),
      });

      if (!response.ok) {
        this.logger.warn('AuthService', `Échec de l'échange de code OAuth2 HA : HTTP ${response.status}`);
        return false;
      }

      const data = (await response.json()) as { access_token?: string };
      return typeof data.access_token === 'string' && data.access_token.length > 0;
    } catch (error) {
      this.logger.error('AuthService', `Erreur réseau lors de l'échange de code OAuth2 HA : ${(error as Error).message}`);
      return false;
    }
  }

  // ==========================================================================
  // Cookie de session — signé HMAC-SHA256, sans état côté serveur
  // ==========================================================================

  signSession(): string {
    const payload: SessionPayload = { exp: Date.now() + this.config.session_ttl_hours * 3600_000 };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = this.sign(payloadB64);
    return `${payloadB64}.${signature}`;
  }

  verifySessionCookie(cookieHeader?: string): boolean {
    const cookies = AuthService.parseCookies(cookieHeader);
    const value = cookies[SESSION_COOKIE];
    if (!value) return false;

    const [payloadB64, signature] = value.split('.');
    if (!payloadB64 || !signature) return false;

    if (!this.timingSafeEqualStrings(signature, this.sign(payloadB64))) return false;

    try {
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as SessionPayload;
      return typeof payload.exp === 'number' && payload.exp > Date.now();
    } catch {
      return false;
    }
  }

  sessionTtlSeconds(): number {
    return this.config.session_ttl_hours * 3600;
  }

  private sign(value: string): string {
    return crypto.createHmac('sha256', this.config.session_secret).update(value).digest('base64url');
  }

  private timingSafeEqualStrings(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }
}
