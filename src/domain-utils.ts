import { domainToASCII } from 'node:url';

/**
 * Canonicalize a URL hostname or hostname pattern for security comparisons.
 *
 * A trailing root label (example.com.) and an IDNA Unicode spelling resolve
 * to the same host as their canonical DNS / ASCII forms. Keeping those forms
 * distinct lets blocklists be bypassed while allowlists fail inconsistently.
 */
export const canonicalizeDomainHostname = (value: string): string => {
  const normalized = value.trim().toLowerCase().replace(/\.+$/, '');
  if (!normalized) {
    return '';
  }
  return domainToASCII(normalized).toLowerCase();
};
