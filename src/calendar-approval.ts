import fs from 'fs';
import https from 'https';
import path from 'path';

import { TIMEZONE } from './config.js';
import { logger } from './logger.js';
import { EventProposal } from './types.js';

const HOME_DIR = process.env.HOME || '/Users/user';
const OAUTH_PATH = path.join(HOME_DIR, '.google-oauth', 'oauth.json');
const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

interface OAuthCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  access_token: string;
  token_expiry: string;
}

function httpsRequest(
  options: https.RequestOptions,
  postBody?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: string) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: data }));
    });
    req.on('error', reject);
    if (postBody) req.write(postBody);
    req.end();
  });
}

async function refreshToken(creds: OAuthCredentials): Promise<{ access_token: string; token_expiry: string }> {
  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
  }).toString();

  const res = await httpsRequest(
    {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    body,
  );

  if (res.status !== 200) {
    let detail = '';
    try {
      const parsed = JSON.parse(res.body);
      detail = parsed.error_description || parsed.error || res.body;
    } catch {
      detail = res.body;
    }
    throw new Error(`Token refresh failed: ${detail}`);
  }

  const data = JSON.parse(res.body);
  return {
    access_token: data.access_token,
    token_expiry: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  };
}

async function getAccessToken(): Promise<string> {
  if (!fs.existsSync(OAUTH_PATH)) {
    throw new Error(`OAuth credentials not found at ${OAUTH_PATH}`);
  }

  const creds: OAuthCredentials = JSON.parse(fs.readFileSync(OAUTH_PATH, 'utf-8'));

  // Check if current token is still valid
  if (creds.access_token && creds.token_expiry) {
    const expiry = new Date(creds.token_expiry).getTime();
    if (Date.now() < expiry - EXPIRY_BUFFER_MS) {
      return creds.access_token;
    }
  }

  // Refresh the token
  const fresh = await refreshToken(creds);

  // Write refreshed token back to disk
  const updated = { ...creds, ...fresh };
  fs.writeFileSync(OAUTH_PATH, JSON.stringify(updated, null, 2));

  return fresh.access_token;
}

export async function createCalendarEvent(
  proposal: EventProposal,
): Promise<{ eventId: string; htmlLink: string }> {
  const token = await getAccessToken();

  const event: Record<string, unknown> = {
    summary: proposal.title,
    description: proposal.description || undefined,
    location: proposal.location || undefined,
    start: { dateTime: proposal.start_time, timeZone: TIMEZONE },
    end: { dateTime: proposal.end_time, timeZone: TIMEZONE },
  };

  if (proposal.attendees.length > 0) {
    event.attendees = proposal.attendees.map((email) => ({ email }));
  }

  const body = JSON.stringify(event);

  const res = await httpsRequest(
    {
      hostname: 'www.googleapis.com',
      path: '/calendar/v3/calendars/primary/events',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    body,
  );

  if (res.status === 401) {
    // Token was stale despite our check — try one more refresh
    logger.warn('Calendar API returned 401, retrying with fresh token');
    const freshToken = await getAccessToken();
    const retryRes = await httpsRequest(
      {
        hostname: 'www.googleapis.com',
        path: '/calendar/v3/calendars/primary/events',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${freshToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      body,
    );

    if (retryRes.status !== 200) {
      const detail = parseApiError(retryRes.body);
      throw new Error(`Calendar API error ${retryRes.status}: ${detail}`);
    }

    const data = JSON.parse(retryRes.body);
    return { eventId: data.id, htmlLink: data.htmlLink };
  }

  if (res.status !== 200) {
    const detail = parseApiError(res.body);
    throw new Error(`Calendar API error ${res.status}: ${detail}`);
  }

  const data = JSON.parse(res.body);
  return { eventId: data.id, htmlLink: data.htmlLink };
}

function parseApiError(body: string): string {
  try {
    const parsed = JSON.parse(body);
    return parsed.error?.message || parsed.error_description || body;
  } catch {
    return body;
  }
}
