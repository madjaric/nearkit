import { defineRailway, empty, preserve, project, service, volume } from 'railway/iac'

/**
 * NearKit on Railway: the Telegram bot + API server (server/, see server/README.md).
 *
 *   railway config plan     # what would change
 *   railway config apply    # make it so
 *   railway up --service nearkit-server --detach   # build server/Dockerfile and deploy
 *
 * Nothing secret lives here. TELEGRAM_BOT_TOKEN is set in Railway by the owner and
 * kept as it is (preserve). Trading stays on the testnet beta, like nearkit.vercel.app;
 * the buybot only READS mainnet. No fee account is set: mainnet trading is not live.
 */
export default defineRailway(() => {
  // The SQLite database (NEARKIT_DB_PATH) must outlive deploys and restarts.
  const data = volume('nearkit-data', { region: 'europe-west4', sizeMB: 1024 })

  const server = service('nearkit-server', {
    source: empty(),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'server/Dockerfile' },
    // One instance: Telegram allows a single long-polling client per bot token.
    replicas: { 'europe-west4': 1 },
    deploy: {
      // Refuse to run without the volume, so data can never land on the container's disk by mistake.
      requiredMountPath: '/data',
      healthcheckPath: '/health',
      healthcheckTimeout: 120,
      // Stop the old instance before the new one polls; give it time to finish and save.
      overlapSeconds: 0,
      drainingSeconds: 20,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      sleepApplication: false,
    },
    volumeMounts: { '/data': data },
    domains: [{ domain: 'nearkit-api.up.railway.app', port: 8080 }],
    env: {
      PORT: '8080',
      NEAR_NETWORK: 'testnet',
      NEARKIT_WEB_URL: 'https://nearkit.vercel.app',
      NEARKIT_API_PUBLIC_URL: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
      NEARKIT_API_ALLOWED_ORIGINS: 'https://nearkit.vercel.app',
      NEARKIT_DB_PATH: '/data/nearkit-testnet.sqlite',
      BUYBOT_ENABLED: 'true',
      BUYBOT_NETWORK: 'mainnet',
      LOG_LEVEL: 'info',
      TELEGRAM_BOT_TOKEN: preserve(),
    },
  })

  return project('nearkit', { resources: [data, server] })
})
