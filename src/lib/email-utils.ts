/**
 * Clean a website/domain URL to extract just the domain name.
 * Removes: https://, http://, www., trailing slashes, paths
 */
export function cleanDomain(raw: string): string {
  if (!raw) return '';
  let d = raw.trim().toLowerCase();
  // Remove protocol
  d = d.replace(/^https?:\/\//, '');
  // Remove www.
  d = d.replace(/^www\./, '');
  // Remove trailing slash and anything after
  d = d.replace(/\/.*$/, '');
  // Remove any remaining whitespace
  d = d.trim();
  return d;
}

/**
 * Generate 6 email patterns from first name, last name, and domain.
 * Returns an array of 6 email strings.
 * 
 * Patterns:
 * 1. firstname.lastname@domain
 * 2. firstname@domain
 * 3. lastname@domain
 * 4. firstname.firstletteroflastname@domain (e.g., john.d@domain)
 * 5. f.lastname@domain (e.g., j.doe@domain)
 * 6. firstnamelastname@domain (e.g., johndoe@domain)
 */
export function generateEmails(firstName: string, lastName: string, domain: string): string[] {
  const f = (firstName || '').trim().toLowerCase();
  const l = (lastName || '').trim().toLowerCase();
  const d = cleanDomain(domain);

  if (!f || !l || !d) return ['', '', '', '', '', ''];

  return [
    `${f}.${l}@${d}`,        // firstname.lastname
    `${f}@${d}`,             // firstname
    `${l}@${d}`,             // lastname
    `${f}.${l[0]}@${d}`,     // firstname.firstletteroflastname
    `${f[0]}.${l}@${d}`,     // f.lastname
    `${f}${l}@${d}`,         // firstnamelastname
  ];
}
