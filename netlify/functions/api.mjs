import serverless from 'serverless-http';
import { app } from '../../server/index.mjs';

export const handler = serverless(app);
