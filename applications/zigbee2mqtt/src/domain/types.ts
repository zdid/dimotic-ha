/** Appareil tel que publié par zigbee2mqtt sur `<base>/bridge/devices` (champs utiles). */
export interface Z2mDevice {
  ieee_address: string;
  friendly_name: string;
  type: 'Coordinator' | 'Router' | 'EndDevice' | string;
  network_address?: number;
  supported?: boolean;
  disabled?: boolean;
  interviewing?: boolean;
  interview_completed?: boolean;
  definition?: { model?: string; vendor?: string; description?: string } | null;
}

export interface Z2mReponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}
