import pino from "pino";
import { Page } from "rebrowser-playwright-core";

const logger = pino();

/**
 * Pause for a specified number of seconds.
 * @param x Minimum number of seconds.
 * @param y Maximum number of seconds (optional).
 */
export const sleep = (x: number, y?: number): Promise<void> => {
  let timeout = x * 1000;
  if (y !== undefined && y !== x) {
    const min = Math.min(x, y);
    const max = Math.max(x, y);
    timeout = Math.floor(Math.random() * (max - min + 1) + min) * 1000;
  }
  // console.log(`Sleeping for ${timeout / 1000} seconds`);
  logger.info(`Sleeping for ${timeout / 1000} seconds`);

  return new Promise(resolve => setTimeout(resolve, timeout));
}

/**
 * @param target A Locator or a page
 * @returns {boolean} 
 */
export const isPage = (target: any): target is Page => {
  return target.constructor.name === 'Page';
}

/**
 * Waits for an hCaptcha image requests and then waits for all of them to end
 * @param page
 * @param signal `const controller = new AbortController(); controller.status`
 * @returns {Promise<void>} 
 */
// Matches hCaptcha image/challenge requests. Suno now proxies hCaptcha through
// `hcaptcha-(imgs|assets|endpoint)-<env>.suno.com`, so the original
// `img*.hcaptcha.com` pattern no longer fires. Configurable via env so future
// proxy renames can be patched without a rebuild.
const DEFAULT_HCAPTCHA_REQUEST_REGEX =
  /^https:\/\/(?:img[a-zA-Z0-9]*\.hcaptcha\.com|hcaptcha-(?:imgs|assets|endpoint)[a-z0-9-]*\.suno\.com)\//i;

function getHcaptchaRequestRegex(): RegExp {
  const fromEnv = process.env.SUNO_HCAPTCHA_REQUEST_REGEX;
  if (!fromEnv) return DEFAULT_HCAPTCHA_REQUEST_REGEX;
  try {
    return new RegExp(fromEnv, 'i');
  } catch (e) {
    logger.warn(`Invalid SUNO_HCAPTCHA_REQUEST_REGEX, using default. Error: ${(e as Error).message}`);
    return DEFAULT_HCAPTCHA_REQUEST_REGEX;
  }
}

export const waitForRequests = (page: Page, signal: AbortSignal): Promise<void> => {
  return new Promise((resolve, reject) => {
    const urlPattern = getHcaptchaRequestRegex();
    const debug = (process.env.SUNO_DEBUG_REQUESTS || '').toLowerCase() === 'true';
    let timeoutHandle: NodeJS.Timeout | null = null;
    let activeRequestCount = 0;
    let requestOccurred = false;
    let nonMatchingSample = 0;

    const cleanupListeners = () => {
      page.off('request', onRequest);
      page.off('request', onAnyRequest);
      page.off('requestfinished', onRequestFinished);
      page.off('requestfailed', onRequestFinished);
    };

    const onAnyRequest = (request: { url: () => string }) => {
      const u = request.url();
      const matched = urlPattern.test(u);
      if (debug && (matched || nonMatchingSample < 25)) {
        if (!matched) nonMatchingSample++;
        logger.info(`[waitForRequests] ${matched ? 'MATCH  ' : 'skip   '} ${u.slice(0, 220)}`);
      }
    };

    const resetTimeout = () => {
      if (timeoutHandle)
        clearTimeout(timeoutHandle);
      if (activeRequestCount === 0) {
        timeoutHandle = setTimeout(() => {
          cleanupListeners();
          resolve();
        }, 1000); // 1 second of no requests
      }
    };

    const onRequest = (request: { url: () => string }) => {
      if (urlPattern.test(request.url())) {
        requestOccurred = true;
        activeRequestCount++;
        if (timeoutHandle)
          clearTimeout(timeoutHandle);
      }
    };

    const onRequestFinished = (request: { url: () => string }) => {
      if (urlPattern.test(request.url())) {
        activeRequestCount--;
        resetTimeout();
      }
    };

    // Wait for an hCaptcha request for up to 1 minute
    const initialTimeout = setTimeout(() => {
      if (!requestOccurred) {
        page.off('request', onRequest);
        cleanupListeners();
        reject(new Error('No hCaptcha request occurred within 1 minute.'));
      } else {
        // Start waiting for no hCaptcha requests
        resetTimeout();
      }
    }, 60000); // 1 minute timeout

    page.on('request', onRequest);
    if (debug) page.on('request', onAnyRequest);
    page.on('requestfinished', onRequestFinished);
    page.on('requestfailed', onRequestFinished);

    // Cleanup the initial timeout if an hCaptcha request occurs
    page.on('request', (request: { url: () => string }) => {
      if (urlPattern.test(request.url())) {
        clearTimeout(initialTimeout);
      }
    });

    const onAbort = () => {
      cleanupListeners();
      clearTimeout(initialTimeout);
      if (timeoutHandle)
        clearTimeout(timeoutHandle);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  }); 
}

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}