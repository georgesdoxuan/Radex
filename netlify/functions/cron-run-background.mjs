import { runNewsMonitoring } from '../../server/index.mjs';

export const handler = async (event) => {
  const providedSecret = event?.headers?.['x-cron-secret'] || event?.headers?.['X-Cron-Secret'];
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return {
      statusCode: 401,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Unauthorized' }),
    };
  }

  try {
    await runNewsMonitoring({ testMode: false });
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' }),
    };
  }
};
