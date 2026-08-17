/**
 * @file api/log.js — Vercel serverless function that receives anonymous solver
 * telemetry from the browser (see reportSolverTelemetry in js/app.js) and
 * writes it to the Vercel runtime logs, where solver problems can be diagnosed
 * (filter the logs for "[solver-telemetry]").
 */

'use strict';

const MAX_BODY_BYTES = 32 * 1024;

module.exports = (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    let payload = req.body;
    if (typeof payload === 'string') {
      if (payload.length > MAX_BODY_BYTES) throw new Error('payload too large');
      payload = JSON.parse(payload);
    }
    if (!payload || typeof payload !== 'object') throw new Error('invalid payload');
    const line = JSON.stringify(payload);
    if (line.length > MAX_BODY_BYTES) throw new Error('payload too large');
    const level = payload.event === 'solver_diagnostics' || payload.severity === 'error' ? 'error' : 'info';
    console[level === 'error' ? 'error' : 'log']('[solver-telemetry]', line);
    res.status(204).end();
  } catch (err) {
    console.warn('[solver-telemetry] discarded malformed payload:', err.message);
    res.status(400).json({ error: 'Bad request' });
  }
};
