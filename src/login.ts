import crypto from 'node:crypto';
import { exec, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import axios, { type AxiosInstance } from 'axios';
import puppeteer from 'puppeteer-core';
import qs from 'qs';
import type { LoginData, Auth0SSOConfig, DiscoverResponse } from './types/carelink.js';
import { writeLoginDataAtomic } from './carelink/token.js';
import { selectAuth0ConfigUrl } from './login-errors.js';
import { DISCOVERY_APP_VERSION, buildDiscoveryUrl } from './discovery.js';
import * as logger from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOGINDATA_FILE = path.join(__dirname, '..', 'logindata.json');


function toBase64Url(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? 'start ""'
    : process.platform === 'darwin' ? 'open'
    : 'xdg-open';
  exec(`${cmd} "${url}"`);
}

function findBrowserPath(): string | undefined {
  if (process.platform === 'win32') {
    const prefixes = [
      process.env['LOCALAPPDATA'],
      process.env['PROGRAMFILES'],
      process.env['PROGRAMFILES(X86)'],
    ].filter(Boolean) as string[];
    const browsers = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ];
    for (const prefix of prefixes) {
      for (const browser of browsers) {
        const p = path.join(prefix, browser);
        if (fs.existsSync(p)) return p;
      }
    }
    return undefined;
  }

  if (process.platform === 'darwin') {
    const browsers = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
    return browsers.find(p => fs.existsSync(p));
  }

  // Linux
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium', 'microsoft-edge']) {
    try {
      const result = execSync(`which ${name}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (result) return result;
    } catch { /* not found */ }
  }
  return undefined;
}

async function resolveAuth0Config(isUS: boolean): Promise<{ ssoConfig: Auth0SSOConfig; baseUrl: string }> {
  const discoveryUrl = buildDiscoveryUrl(isUS);

  logger.info('Fetching discovery config...', { component: 'login' });
  const discoverResp = await axios.get<DiscoverResponse>(discoveryUrl);
  const discoverData = discoverResp.data;

  const region = isUS ? 'us' : 'eu';
  const cpEntry = discoverData.CP.find(c => c.region.toLowerCase() === region);
  if (!cpEntry) {
    throw new Error('Could not find config for region: ' + region);
  }
  const ssoUrl = selectAuth0ConfigUrl(cpEntry, { region, appVersion: DISCOVERY_APP_VERSION });

  logger.info('Fetching Auth0 SSO config...', { component: 'login' });
  const ssoResp = await axios.get<Auth0SSOConfig>(ssoUrl);
  const ssoConfig = ssoResp.data;

  let baseUrl = 'https://' + ssoConfig.server.hostname;
  if (ssoConfig.server.port && ssoConfig.server.port !== 443) {
    baseUrl += ':' + ssoConfig.server.port;
  }
  if (ssoConfig.server.prefix) {
    baseUrl += '/' + ssoConfig.server.prefix;
  }

  return { ssoConfig, baseUrl };
}

// ---------------------------------------------------------------------------
// Strategy 1: Automated login — POST credentials directly to Auth0
// ---------------------------------------------------------------------------
async function loginAutomated(
  username: string,
  password: string,
  ssoConfig: Auth0SSOConfig,
  baseUrl: string,
  codeVerifier: string,
  codeChallenge: string,
): Promise<string> {
  const httpClient: AxiosInstance = axios.create({
    maxRedirects: 0,
    timeout: 20_000,
    validateStatus: () => true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const cookies = new Map<string, string>();
  httpClient.interceptors.request.use(config => {
    if (cookies.size > 0) {
      config.headers['Cookie'] = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    return config;
  });
  httpClient.interceptors.response.use(resp => {
    const sc = resp.headers['set-cookie'];
    if (sc) {
      for (const c of sc) {
        const m = c.match(/^([^=]+)=([^;]*)/);
        if (m) cookies.set(m[1], m[2]);
      }
    }
    return resp;
  });

  const client = ssoConfig.client;
  const authorizeUrl = baseUrl + ssoConfig.system_endpoints.authorization_endpoint_path;
  const authorizeParams = {
    client_id: client.client_id,
    response_type: 'code',
    scope: client.scope,
    audience: client.audience,
    redirect_uri: client.redirect_uri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: toBase64Url(crypto.randomBytes(16)),
  };

  logger.info('Starting automated login...', { component: 'login' });
  let resp = await httpClient.get(authorizeUrl + '?' + qs.stringify(authorizeParams));

  // Follow redirects to the login page
  let auth0Origin = new URL(authorizeUrl).origin;
  let loginPageUrl = '';
  for (let i = 0; i < 10 && resp.status >= 300 && resp.status < 400; i++) {
    const location = resp.headers['location'];
    if (!location) break;
    const nextUrl = location.startsWith('/') ? auth0Origin + location : location;
    auth0Origin = new URL(nextUrl).origin;
    loginPageUrl = nextUrl;
    resp = await httpClient.get(nextUrl);
  }

  if (resp.status !== 200 || typeof resp.data !== 'string') {
    throw new Error('Could not reach Auth0 login page (HTTP ' + resp.status + ')');
  }

  const html: string = resp.data;

  // Extract hidden form fields
  const hiddenFields: Record<string, string> = {};
  const hiddenRegex = /<input[^>]+type=["']hidden["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = hiddenRegex.exec(html)) !== null) {
    const nameMatch = match[0].match(/name=["']([^"']*)["']/i);
    const valueMatch = match[0].match(/value=["']([^"']*)["']/i);
    if (nameMatch) {
      hiddenFields[nameMatch[1]] = valueMatch ? valueMatch[1] : '';
    }
  }

  const formActionMatch = html.match(/<form[^>]*action=["']([^"']*)["']/i);
  const postUrl = formActionMatch
    ? (formActionMatch[1].startsWith('/') ? auth0Origin + formActionMatch[1] : formActionMatch[1])
    : loginPageUrl;

  // POST credentials
  logger.info('Submitting credentials...', { component: 'login' });
  resp = await httpClient.post(postUrl, qs.stringify({
    ...hiddenFields,
    username,
    password,
    action: 'default',
  }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (resp.status === 200 && typeof resp.data === 'string') {
    if (resp.data.includes('Wrong username or password') || resp.data.includes('wrong-credentials')) {
      throw new Error('Invalid username or password');
    }
    if (resp.data.includes('captcha') || resp.data.includes('CAPTCHA') || resp.data.includes('arkose')) {
      throw new Error('CAPTCHA required');
    }
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new Error('Login rejected (HTTP ' + resp.status + ')');
  }

  // Follow redirect chain to extract auth code
  let code: string | undefined;
  for (let i = 0; i < 15; i++) {
    const location = resp.headers['location'] || '';
    const codeMatch = location.match(/[?&]code=([^&]+)/);
    if (codeMatch) { code = codeMatch[1]; break; }

    if (resp.status >= 300 && resp.status < 400 && location) {
      const nextUrl = location.startsWith('/') ? auth0Origin + location : location;
      if (nextUrl.match(/^[a-z]+:\/\//) && !nextUrl.startsWith('http')) {
        const m = nextUrl.match(/code=([^&]+)/);
        if (m) { code = m[1]; break; }
      }
      resp = await httpClient.get(nextUrl);
    } else {
      break;
    }
  }

  if (!code) {
    throw new Error('Could not extract authorization code from redirect chain');
  }

  logger.info('Got authorization code', { component: 'login' });
  return code;
}

// ---------------------------------------------------------------------------
// Strategy 2: Browser window — puppeteer-core intercepts the redirect
// ---------------------------------------------------------------------------
async function loginViaBrowser(
  ssoConfig: Auth0SSOConfig,
  baseUrl: string,
  codeChallenge: string,
): Promise<string> {
  const browserPath = findBrowserPath();
  if (!browserPath) {
    throw new Error('No Chrome, Edge, or Chromium browser found on this system');
  }

  const client = ssoConfig.client;
  const auth0Host = new URL(baseUrl).hostname;

  const authorizeUrl = baseUrl + ssoConfig.system_endpoints.authorization_endpoint_path;
  const params = {
    client_id: client.client_id,
    response_type: 'code',
    scope: client.scope,
    audience: client.audience,
    redirect_uri: client.redirect_uri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: toBase64Url(crypto.randomBytes(16)),
  };
  const fullUrl = authorizeUrl + '?' + qs.stringify(params);

  logger.info('Opening browser window...', { component: 'login' });
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: false,
    defaultViewport: null,
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=500,700'],
  });

  const page = (await browser.pages())[0] || await browser.newPage();

  // Use CDP directly — puppeteer's high-level events don't reliably fire
  // for redirects to custom URL schemes (com.medtronic.carelink://...)
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');

  return new Promise<string>((resolve, reject) => {
    let resolved = false;

    function extractCode(url: string): string | undefined {
      // Skip Auth0's own URLs (they have code_challenge= not code=)
      try { if (new URL(url).hostname === auth0Host) return undefined; } catch { /* custom scheme */ }
      const m = url.match(/[?&]code=([^&]+)/);
      return m?.[1];
    }

    function done(code: string): void {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      logger.info('Got authorization code', { component: 'login' });
      browser.close().catch(() => {});
      resolve(code);
    }

    function fail(err: Error): void {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      browser.close().catch(() => {});
      reject(err);
    }

    const timeout = setTimeout(
      () => fail(new Error('Login timed out after 5 minutes')),
      5 * 60 * 1000,
    );

    browser.on('disconnected', () => {
      fail(new Error('Browser was closed before login completed'));
    });

    // CDP: catch 302 responses with Location header containing the code
    cdp.on('Network.responseReceived', (event) => {
      if (resolved) return;
      const { status, headers } = event.response;
      if (status >= 300 && status < 400 && headers) {
        const location = headers['Location'] || headers['location'] || '';
        const code = extractCode(location);
        if (code) done(code);
      }
    });

    // CDP: catch requests triggered by redirects (redirect to custom scheme)
    cdp.on('Network.requestWillBeSent', (event) => {
      if (resolved) return;
      // Check the request URL itself (might be the custom scheme)
      const code = extractCode(event.request.url);
      if (code) { done(code); return; }
      // Check the redirect response that triggered this request
      if (event.redirectResponse) {
        const headers = event.redirectResponse.headers;
        const location = headers['Location'] || headers['location'] || '';
        const code = extractCode(location);
        if (code) done(code);
      }
    });

    // Fallback: puppeteer high-level events
    page.on('framenavigated', (frame) => {
      if (resolved || frame !== page.mainFrame()) return;
      const code = extractCode(frame.url());
      if (code) done(code);
    });

    browser.on('targetchanged', (target) => {
      if (resolved) return;
      const code = extractCode(target.url());
      if (code) done(code);
    });

    logger.info('Log in to CareLink in the browser window...', { component: 'login' });
    page.goto(fullUrl, { waitUntil: 'domcontentloaded' }).catch(() => {
      // Navigation error is expected if there's an immediate redirect
    });
  });
}

// ---------------------------------------------------------------------------
// Strategy 3: Terminal paste fallback
// ---------------------------------------------------------------------------
async function loginViaTerminal(
  ssoConfig: Auth0SSOConfig,
  baseUrl: string,
  codeChallenge: string,
): Promise<string> {
  const client = ssoConfig.client;
  const authorizeUrl = baseUrl + ssoConfig.system_endpoints.authorization_endpoint_path;
  const params = {
    client_id: client.client_id,
    response_type: 'code',
    scope: client.scope,
    audience: client.audience,
    redirect_uri: client.redirect_uri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: toBase64Url(crypto.randomBytes(16)),
  };
  const fullUrl = authorizeUrl + '?' + qs.stringify(params);

  console.log('');
  console.log('Open this URL and log in:');
  console.log(fullUrl);
  console.log('');
  console.log('After login the page will error — that\'s expected.');
  console.log('Open DevTools (F12) > Network tab, filter for "code=".');
  console.log('Right-click the request > Copy > Copy URL, then paste below.');
  console.log('');

  openBrowser(fullUrl);

  const pastedUrl = await prompt('Paste the URL here: ');
  const codeMatch = pastedUrl.match(/code=([^&]+)/);
  if (!codeMatch) {
    throw new Error('No code= found in that URL.');
  }
  return codeMatch[1];
}

// ---------------------------------------------------------------------------
// Main login entry point
// ---------------------------------------------------------------------------
export async function login(isUS: boolean, username?: string, password?: string): Promise<LoginData> {
  const { ssoConfig, baseUrl } = await resolveAuth0Config(isUS);
  const client = ssoConfig.client;

  const codeVerifier = toBase64Url(crypto.randomBytes(32));
  const codeChallenge = toBase64Url(
    crypto.createHash('sha256').update(codeVerifier).digest(),
  );

  let authCode: string | undefined;

  // Strategy 1: Automated login (no browser)
  if (username && password) {
    try {
      authCode = await loginAutomated(username, password, ssoConfig, baseUrl, codeVerifier, codeChallenge);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('Invalid username or password')) throw err;
      if (msg.includes('CAPTCHA')) {
        logger.warn('CAPTCHA detected — opening browser', { component: 'login' });
      } else {
        logger.warn('Automated login failed', { component: 'login', error: msg });
        logger.info('Falling back to browser...', { component: 'login' });
      }
    }
  }

  // Strategy 2: Browser window (puppeteer-core)
  if (!authCode) {
    try {
      authCode = await loginViaBrowser(ssoConfig, baseUrl, codeChallenge);
    } catch (err) {
      const msg = (err as Error).message;
      logger.warn('Browser login failed', { component: 'login', error: msg });
      logger.info('Falling back to terminal...', { component: 'login' });
      authCode = await loginViaTerminal(ssoConfig, baseUrl, codeChallenge);
    }
  }

  // Exchange authorization code for tokens
  logger.info('Exchanging code for tokens...', { component: 'login' });
  const tokenUrl = baseUrl + ssoConfig.system_endpoints.token_endpoint_path;
  const tokenResp = await axios.post(tokenUrl, qs.stringify({
    grant_type: 'authorization_code',
    client_id: client.client_id,
    code: authCode,
    redirect_uri: client.redirect_uri,
    code_verifier: codeVerifier,
  }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (tokenResp.status !== 200) {
    throw new Error('Token exchange failed: ' + JSON.stringify(tokenResp.data));
  }

  logger.info('Got tokens', { component: 'login' });

  const loginData: LoginData = {
    access_token: tokenResp.data.access_token,
    refresh_token: tokenResp.data.refresh_token,
    scope: tokenResp.data.scope || client.scope,
    client_id: client.client_id,
    token_url: tokenUrl,
    audience: client.audience,
  };

  writeLoginDataAtomic(LOGINDATA_FILE, loginData);
  logger.info('Saved to logindata.json', { component: 'login' });
  return loginData;
}

// ---------------------------------------------------------------------------
// Standalone CLI mode
// ---------------------------------------------------------------------------
const isMainModule = process.argv[1] &&
  (path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) ||
   path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url).replace(/\.ts$/, '.js')));

if (isMainModule) {
  const dotenv = await import('dotenv');
  dotenv.config();
  // Interactive one-shot CLI: progress lines are the UX, so always show info.
  // (When login() runs inside the daemon, the daemon's verbose flag governs.)
  logger.setVerbose(true);

  const isUS = (process.env['MMCONNECT_SERVER'] || 'EU').toUpperCase() !== 'EU';
  logger.info(`Region: ${isUS ? 'US' : 'EU'}`, { component: 'login', region: isUS ? 'US' : 'EU' });

  if (fs.existsSync(LOGINDATA_FILE)) {
    logger.info('logindata.json already exists.', { component: 'login' });
    logger.info('Delete it first if you want to re-login.', { component: 'login' });
    process.exit(0);
  }

  const username = process.env['CARELINK_USERNAME'];
  const password = process.env['CARELINK_PASSWORD'];

  if (username && password) {
    logger.info('Found credentials in .env, trying automated login first...', { component: 'login' });
  }

  try {
    await login(isUS, username, password);
    console.log('');
    console.log('Login successful! You can now run: npm start');
  } catch (err) {
    logger.error('Login failed', { component: 'login', error: (err as Error).message });
    process.exit(1);
  }
}
