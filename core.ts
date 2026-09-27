// Shared types and pure helpers for the pdf2w Obsidian plugin.
//
// Split out of main.ts to keep every plugin file under the 500-line code-quality
// limit. Nothing here touches the Obsidian API: these are plain values and pure
// string builders, so main.ts and settings.ts can both import them without a
// cycle.

export interface Pdf2MdSettings {
  serviceUrl: string;
  apiKey: string;
  detectTables: boolean;
  autoAuditInvoices: boolean;
  debugMode: boolean;
}

export const DEFAULT_SETTINGS: Pdf2MdSettings = {
  serviceUrl: 'http://127.0.0.1:3984',
  apiKey: '',
  detectTables: true,
  autoAuditInvoices: false,
  debugMode: false,
};

interface FrenchInvoiceTaxRow {
  rate_percent: number;
  base_ht: number;
  tva: number;
}

export interface FrenchInvoiceAudit {
  invoice_number: string;
  invoice_date: string;
  siret: string;
  siret_valid: boolean;
  vat_number: string;
  vat_number_valid: boolean;
  is_exempt_293b: boolean;
  total_ht: number;
  total_tva: number;
  total_ttc: number;
  reconciled: boolean;
  delta_cents: number;
  tax_breakdown: Record<string, FrenchInvoiceTaxRow>;
}

export interface ConvertResponse {
  ok: boolean;
  markdown: string;
  pages: number;
  words: number;
  tables?: number;
  engine?: string;
  credits_consumed?: number;
  reason?: string;
  error?: string;
  french_invoice?: FrenchInvoiceAudit;
  french_invoice_error?: string;
}

const AUDIT_BLOCK_RE = /%%pdf2w-audit\n([\s\S]*?)\n%%/;

function yamlScalar(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isoDateFromFrench(d: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d.trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

export function buildBasicFrontmatter(pdfPath: string): string {
  return ['---', 'type: document', `pdf_source: ${yamlScalar(`[[${pdfPath}]]`)}`, 'tags:', '  - pdf2w', '---'].join('\n');
}

export function buildInvoiceFrontmatter(audit: FrenchInvoiceAudit, pdfPath: string): string {
  const lines: string[] = ['---', 'type: invoice'];

  if (audit.invoice_number) lines.push(`invoice_no: ${yamlScalar(audit.invoice_number)}`);
  const isoDate = audit.invoice_date ? isoDateFromFrench(audit.invoice_date) : null;
  if (isoDate) lines.push(`date: ${isoDate}`);
  else if (audit.invoice_date) lines.push(`date: ${yamlScalar(audit.invoice_date)}`);

  if (audit.siret) {
    lines.push(`siret: ${yamlScalar(audit.siret)}`);
    lines.push(`siret_valid: ${audit.siret_valid}`);
  }
  if (audit.vat_number) {
    lines.push(`vat_number: ${yamlScalar(audit.vat_number)}`);
    lines.push(`vat_number_valid: ${audit.vat_number_valid}`);
  }
  lines.push(`exempt_293b: ${audit.is_exempt_293b}`);
  lines.push(`total_ht: ${audit.total_ht}`);
  lines.push(`total_tva: ${audit.total_tva}`);
  lines.push(`total_ttc: ${audit.total_ttc}`);
  lines.push('currency: EUR');
  lines.push(`reconciled: ${audit.reconciled}`);
  if (!audit.reconciled) lines.push(`delta_cents: ${audit.delta_cents}`);
  lines.push(`pdf_source: ${yamlScalar(`[[${pdfPath}]]`)}`);
  lines.push('tags:');
  lines.push('  - pdf2w/invoice');
  lines.push(audit.reconciled ? '  - pdf2w/reconciled' : '  - pdf2w/unreconciled');
  lines.push('---');
  return lines.join('\n');
}

export function buildAuditBlock(audit: FrenchInvoiceAudit): string {
  return `\n\n%%pdf2w-audit\n${JSON.stringify(audit)}\n%%\n`;
}

export function extractAuditFromContent(content: string): FrenchInvoiceAudit | null {
  const m = AUDIT_BLOCK_RE.exec(content);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}
