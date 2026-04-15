import { runNewsMonitoring } from '../../server/index.mjs';

export const handler = async () => {
  // Return immediately to avoid client-side timeout.
  setTimeout(() => {
    runNewsMonitoring({ testMode: true }).catch((error) => {
      console.error('[run-test-background] failed', error);
    });
  }, 0);
  return {
    statusCode: 202,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ queued: true }),
  };
};

export default async () => {
  try {
    await runNewsMonitoring({ testMode: true });
  } catch (error) {
    console.error('[run-test-background] failed', error);
  }
};
