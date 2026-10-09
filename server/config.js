import { resolve } from 'node:path';

export function readConfig(env = process.env) {
  const config = {
    host: env.PLANIFIKATEUR_HOST || '127.0.0.1', port: Number(env.PORT || 3000),
    database: resolve(env.PLANIFIKATEUR_DB_PATH || '.data/planifikateur.sqlite'),
    ownerToken: env.PLANIFIKATEUR_OWNER_TOKEN || '', readToken: env.PLANIFIKATEUR_READ_TOKEN || '',
    secureCookie: env.NODE_ENV === 'production' || env.PLANIFIKATEUR_PUBLIC_ORIGIN?.startsWith('https://') || false,
  };
  if ((!['127.0.0.1', 'localhost', '::1'].includes(config.host) || env.NODE_ENV === 'production') && (!config.ownerToken || !config.readToken)) {
    throw new Error('Définissez PLANIFIKATEUR_OWNER_TOKEN et PLANIFIKATEUR_READ_TOKEN avant d’exposer le serveur hors de la machine locale.');
  }
  if (config.ownerToken && config.ownerToken === config.readToken) throw new Error('Les clés propriétaire et lecture doivent être différentes.');
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('PORT invalide.');
  return config;
}
