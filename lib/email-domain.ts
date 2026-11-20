import { promises as dns } from 'node:dns';

const MX_LOOKUP_TIMEOUT_MS = 4000;

/**
 * Checks that the domain has at least one valid MX record.
 * DNS failures and timeouts are treated as "not deliverable".
 */
export async function hasValidMxRecords(domain: string): Promise<boolean> {
  const normalized = domain.trim().toLowerCase();

  if (!normalized || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(normalized)) {
    return false;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const lookup = dns.resolveMx(normalized);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('MX lookup timed out')), MX_LOOKUP_TIMEOUT_MS);
    });

    const records = await Promise.race([lookup, timeout]);

    return records.some((record) => Boolean(record.exchange) && record.exchange !== '.');
  } catch (error) {
    console.warn(
      '[EMAIL MX] Could not resolve MX records for',
      normalized,
      '-',
      error instanceof Error ? error.message : 'unknown error'
    );
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
