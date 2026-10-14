import { resolve, dirname, join } from 'node:path';

export function readConfig(env = process.env) {
  const config = {
    host: env.PLANIFIKATEUR_HOST || '127.0.0.1',
    port: Number(env.PORT || 3000),
    database: resolve(env.PLANIFIKATEUR_DB_PATH || '.data/planifikateur.sqlite'),
    ownerToken: env.PLANIFIKATEUR_OWNER_TOKEN || '',
    readToken: env.PLANIFIKATEUR_READ_TOKEN || '',
    githubWebhookSecret: env.PLANIFIKATEUR_GITHUB_WEBHOOK_SECRET || '',
    claudeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN || '',
    refineModel: env.PLANIFIKATEUR_REFINE_MODEL || '',
    secureCookie: env.NODE_ENV === 'production' || env.PLANIFIKATEUR_PUBLIC_ORIGIN?.startsWith('https://') || false,
  };
  if (
    (!['127.0.0.1', 'localhost', '::1'].includes(config.host) || env.NODE_ENV === 'production') &&
    (!config.ownerToken || !config.readToken)
  ) {
    throw new Error(
      'Définissez PLANIFIKATEUR_OWNER_TOKEN et PLANIFIKATEUR_READ_TOKEN avant d’exposer le serveur hors de la machine locale.',
    );
  }
  if (config.ownerToken && config.ownerToken === config.readToken)
    throw new Error('Les clés propriétaire et lecture doivent être différentes.');
  if (config.refineModel && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(config.refineModel))
    throw new Error('PLANIFIKATEUR_REFINE_MODEL : identifiant de modèle invalide.');
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('PORT invalide.');
  config.backupDirectory = resolve(env.PLANIFIKATEUR_BACKUP_DIR || join(dirname(config.database), 'backups'));
  config.backupIntervalMs = Number(env.PLANIFIKATEUR_BACKUP_INTERVAL_HOURS || 6) * 3600000;
  config.backupKeep = Number(env.PLANIFIKATEUR_BACKUP_KEEP || 28);
  if (
    !Number.isFinite(config.backupIntervalMs) ||
    config.backupIntervalMs < 3600000 ||
    config.backupIntervalMs > 168 * 3600000
  )
    throw new Error('Intervalle de sauvegarde invalide (1 à 168 heures).');
  if (!Number.isInteger(config.backupKeep) || config.backupKeep < 1 || config.backupKeep > 100)
    throw new Error('Nombre de sauvegardes invalide (1 à 100).');
  return config;
}
