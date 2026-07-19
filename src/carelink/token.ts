import fs from 'node:fs';
import axios from 'axios';
import qs from 'qs';
import type { LoginData } from '../types/carelink.js';

export function loadLoginData(filePath: string): LoginData | null {
  try {
    if (!fs.existsSync(filePath)) return null;

    const data: LoginData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const required: (keyof LoginData)[] = ['access_token', 'refresh_token', 'client_id', 'token_url'];

    for (const field of required) {
      if (!data[field]) {
        console.log('[Token] logindata.json missing field: ' + field);
        return null;
      }
    }
    return data;
  } catch (e) {
    console.log('[Token] Failed to read logindata.json:', (e as Error).message);
    return null;
  }
}

export function saveLoginData(filePath: string, data: LoginData): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 4));
}

/**
 * Decodes the payload (claims) of a JWT access token without verifying its
 * signature — we only read claims we already trust the server for (exp,
 * token_details). Returns null for a malformed token.
 */
export function decodeTokenPayload(accessToken: string): Record<string, unknown> | null {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function isTokenExpired(accessToken: string): boolean {
  const payload = decodeTokenPayload(accessToken);
  if (!payload || typeof payload.exp !== 'number') return true;

  // Expired if less than 10 minutes remaining — wide enough that a token
  // passing this check can't expire mid-fetch (matches the margin used by
  // carelink-python-client's reference implementation).
  return payload.exp * 1000 < Date.now() + 600 * 1000;
}

export async function refreshToken(loginData: LoginData): Promise<LoginData> {
  console.log('[Token] Refreshing access token...');

  const resp = await axios.post(
    loginData.token_url,
    qs.stringify({
      grant_type: 'refresh_token',
      client_id: loginData.client_id,
      refresh_token: loginData.refresh_token,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  loginData.access_token = resp.data.access_token;
  if (resp.data.refresh_token) {
    loginData.refresh_token = resp.data.refresh_token;
  }

  console.log('[Token] Token refreshed successfully');
  return loginData;
}
