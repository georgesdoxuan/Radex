import { runNewsMonitoring } from '../../server/index.mjs';

export const handler = async () => {
  try {
    await runNewsMonitoring({ testMode: false });
    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ok: true }),
    };
  } catch (error) {
    console.error('[run-analysis-background] failed', error);
    return {
      statusCode: 500,
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' }),
    };
  }
};
