/**
 * Schéma de configuration de l'application ESPHOME — fonctionnelles-esphome_specs v1.2 §3.
 *
 * Une seule application, deux options (`usine`, `poseur`) activables séparément par machine : chez
 * l'utilisateur ha2 = poseur, falbala = usine ; chez noisy, noisy2 = poseur ; l'usine de falbala sert les
 * deux sites. Aucun secret ici en clair dans un dépôt : les mots de passe MQTT sont des champs `password`
 * du formulaire (stockés avec les secrets du cœur) ; les clés API et wifi restent dans le `secrets.yaml`
 * d'ESPHome, sur la machine de l'usine.
 */

import { z } from 'zod';

const brokerSchema = z.object({
  hote: z.string().default(''),
  port: z.number().int().min(1).max(65535).default(1883),
  utilisateur: z.string().default(''),
  motDePasse: z.string().default('')
});

const siteServiSchema = z.object({
  id: z.string().min(1),
  mqtt: brokerSchema.default({})
});

const usineSchema = z.object({
  actif: z.boolean().default(false),
  // Nom de la machine qui héberge ESPHome (sujet de présence `agent/<machine>`) ; vide = nom d'hôte de la machine.
  machine: z.string().default(''),
  esphome: z
    .object({
      conteneur: z.string().default('esphome'),
      dossierConfig: z.string().default('/esphome-config'),
      // Chemin du même dossier VU DEPUIS le conteneur ESPHome (là où `esphome compile` le lit).
      cheminDansConteneur: z.string().default('/config'),
      // Version figée (compilations reproductibles) ; montée de version volontaire.
      image: z.string().default('esphome/esphome:2025.11.2'),
      socketDocker: z.string().default('/var/run/docker.sock')
    })
    .default({}),
  sites: z.array(siteServiSchema).default([]),
  conservation: z
    .object({
      revisions: z.number().int().min(1).max(50).default(5),
      nettoyageJours: z.number().int().min(1).max(365).default(30)
    })
    .default({}),
  premierFlash: z
    .object({
      peripherique: z.string().default('/dev/ttyUSB0'),
      // Reconnaître la carte (puce, flash, MAC) avant tout flash par USB — §5.4.
      reconnaissance: z.boolean().default(true)
    })
    .default({})
});

const poseurSchema = z.object({
  actif: z.boolean().default(false),
  mqtt: brokerSchema.default({ hote: '127.0.0.1' }),
  tentatives: z
    .object({
      intervalleMinutes: z.number().int().min(1).max(60).default(5),
      dureeMinutes: z.number().int().min(1).max(1440).default(60)
    })
    .default({})
});

export const esphomeConfigSchema = z
  .object({
    // Site de cette machine : figure dans tous les sujets MQTT (sites étanches).
    site: z.string().min(1).default('stfort'),
    // Adresse de cette instance VUE DES AUTRES SITES (ex. 10.10.10.3:8087) ; vide = adresse locale + port web.
    adresseJoignable: z.string().default(''),
    usine: usineSchema.default({}),
    poseur: poseurSchema.default({})
  })
  .refine((c) => new Set(c.usine.sites.map((s) => s.id)).size === c.usine.sites.length, {
    message: 'Chaque site servi par l\'usine doit avoir un id unique',
    path: ['usine', 'sites']
  });

export type EsphomeConfig = z.infer<typeof esphomeConfigSchema>;
export type BrokerConfig = z.infer<typeof brokerSchema>;

export const DEFAULT_ESPHOME_CONFIG: EsphomeConfig = esphomeConfigSchema.parse({});
