import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';

interface Pdf2MdSettings {
  serviceUrl: string;
  apiKey: string;
  createSeparateNote: boolean;
  detectTables: boolean;
  autoAuditInvoices: boolean;
}

const DEFAULT_SETTINGS: Pdf2MdSettings = {
  serviceUrl: 'http://127.0.0.1:3984',
  apiKey: '',
  createSeparateNote: false,
  detectTables: true,
  autoAuditInvoices: false,
};

interface FrenchInvoiceTaxRow {
  rate_percent: number;
  base_ht: number;
  tva: number;
}

interface FrenchInvoiceAudit {
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

interface ConvertResponse {
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

function buildBasicFrontmatter(pdfPath: string): string {
  return ['---', 'type: document', `pdf_source: ${yamlScalar(`[[${pdfPath}]]`)}`, 'tags:', '  - pdf2w', '---'].join('\n');
}

function buildInvoiceFrontmatter(audit: FrenchInvoiceAudit, pdfPath: string): string {
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

function buildAuditBlock(audit: FrenchInvoiceAudit): string {
  return `\n\n%%pdf2w-audit\n${JSON.stringify(audit)}\n%%\n`;
}

function extractAuditFromContent(content: string): FrenchInvoiceAudit | null {
  const m = AUDIT_BLOCK_RE.exec(content);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export default class Pdf2MdPlugin extends Plugin {
  settings: Pdf2MdSettings = DEFAULT_SETTINGS;
  private statusBarItem: HTMLElement;
  private statusClearTimeout: number | null = null;

  async onload() {
    await this.loadSettings();

    this.statusBarItem = this.addStatusBarItem();

    // 1. Ribbon icon for manual file picker conversion
    this.addRibbonIcon('document', 'Convert PDF to Markdown', () => {
      this.promptPdfConversion();
    });

    // 2. Command Palette: plain conversion
    this.addCommand({
      id: 'convert-pdf-to-markdown',
      name: 'Convert PDF file to Markdown',
      editorCallback: (editor: Editor, _view: MarkdownView) => {
        this.promptPdfConversion(editor, { audit: false });
      },
    });

    // 2b. Command Palette: convert + audit as French invoice (always a separate note)
    this.addCommand({
      id: 'convert-pdf-and-audit-invoice',
      name: 'Convert PDF and audit as French invoice',
      callback: () => this.promptPdfConversion(undefined, { audit: true }),
    });

    // 2c. Copy the active note's invoice audit as Excel/Sheets TSV
    this.addCommand({
      id: 'copy-invoice-audit-tsv',
      name: 'Copy invoice audit as Excel TSV',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.copyAuditAsTsv(file);
        return true;
      },
    });

    // 2d. Export the active note's invoice audit to a FEC entry
    this.addCommand({
      id: 'export-invoice-audit-fec',
      name: 'Export invoice audit to FEC (.txt)',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.exportSingleFec(file);
        return true;
      },
    });

    // 2e. Export every audited invoice in the active note's folder to one FEC journal
    this.addCommand({
      id: 'export-folder-invoices-fec',
      name: 'Export folder invoices to FEC (batch)',
      callback: () => this.exportFolderToFec(),
    });

    // 3. File Context Menu: Right click any PDF file in file explorer
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile && file.extension.toLowerCase() === 'pdf') {
          menu.addItem((item) => {
            item
              .setTitle('Convert to Markdown (pdf2w)')
              .setIcon('document')
              .onClick(() => this.handlePdfToNote(file, { audit: false }));
          });
          menu.addItem((item) => {
            item
              .setTitle('Convert & audit as French invoice (pdf2w)')
              .setIcon('file-check')
              .onClick(() => this.handlePdfToNote(file, { audit: true }));
          });
        }
      })
    );

    // 4. Drag-and-drop listener on active markdown editor
    this.registerEvent(
      this.app.workspace.on('editor-drop', async (evt: DragEvent, editor: Editor, view: MarkdownView) => {
        const files = evt.dataTransfer?.files;
        if (!files || files.length === 0) return;

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (!file.name.toLowerCase().endsWith('.pdf')) continue;
          evt.preventDefault();

          const start = Date.now();
          this.setStatus(`⚡ pdf2w: converting ${file.name}...`);
          try {
            const buffer = await file.arrayBuffer();
            const audit = this.settings.autoAuditInvoices;
            if (audit || this.settings.createSeparateNote) {
              const folder = view.file?.parent?.path ?? '';
              const pdfPath = await this.savePdfToVault(file.name, buffer, folder);
              const { content } = await this.buildNoteContent(file.name, buffer, pdfPath, audit);
              const noteName = pdfPath.replace(/\.pdf$/i, '.md');
              await this.app.vault.create(noteName, content);
              new Notice(`[pdf2w] Created ${noteName}!`);
            } else {
              const res = await this.convert(file.name, buffer, { audit: false });
              editor.replaceSelection(res.markdown);
              new Notice(`[pdf2w] Injected ${file.name} Markdown!`);
            }
            this.setStatus(`✔ pdf2w: done in ${Date.now() - start}ms`, 3000);
          } catch (err: any) {
            this.setStatus('✖ pdf2w: error', 4000);
            new Notice(`[pdf2w] Error: ${err.message}`);
          }
        }
      })
    );

    // 5. Settings Tab
    this.addSettingTab(new Pdf2MdSettingTab(this.app, this));
  }

  setStatus(text: string, autoClearMs?: number) {
    this.statusBarItem.setText(text);
    if (this.statusClearTimeout !== null) window.clearTimeout(this.statusClearTimeout);
    if (autoClearMs) {
      this.statusClearTimeout = window.setTimeout(() => this.statusBarItem.setText(''), autoClearMs);
    }
  }

  /** POST /convert — raw PDF body, JSON response. Works against both the local self-hosted server and the SaaS gateway. */
  async convert(filename: string, data: ArrayBuffer, opts: { audit: boolean }): Promise<ConvertResponse> {
    const base = this.settings.serviceUrl.replace(/\/$/, '');
    const params = new URLSearchParams();
    if (opts.audit) params.set('french_invoice_audit', '1');
    if (this.settings.detectTables) params.set('vectors', '1');
    const qs = params.toString();
    const url = `${base}/convert${qs ? '?' + qs : ''}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/pdf',
      'X-File-Name': filename,
    };
    if (this.settings.apiKey.trim()) headers['Authorization'] = `Bearer ${this.settings.apiKey.trim()}`;

    const response = await fetch(url, { method: 'POST', headers, body: data });
    const text = await response.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Unexpected response (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
    if (!response.ok || json.ok === false) {
      throw new Error(json.error || `HTTP ${response.status}`);
    }
    return json as ConvertResponse;
  }

  /** POST a JSON body to a service path and return the raw text response (used by the TSV/FEC export endpoints). */
  async postJson(path: string, body: unknown): Promise<string> {
    const base = this.settings.serviceUrl.replace(/\/$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.settings.apiKey.trim()) headers['Authorization'] = `Bearer ${this.settings.apiKey.trim()}`;

    const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok) {
      let msg = text;
      try {
        msg = JSON.parse(text).error ?? text;
      } catch {
        // response wasn't JSON; use the raw text
      }
      throw new Error(`HTTP ${response.status}: ${msg}`);
    }
    return text;
  }

  /** Converts a PDF and assembles note content: YAML frontmatter (when audited), the extracted Markdown, and a hidden audit-data block for later TSV/FEC export. */
  async buildNoteContent(
    filename: string,
    buffer: ArrayBuffer,
    pdfPath: string,
    audit: boolean
  ): Promise<{ content: string; res: ConvertResponse }> {
    const res = await this.convert(filename, buffer, { audit });
    let content = '';
    if (audit && res.french_invoice) {
      content += buildInvoiceFrontmatter(res.french_invoice, pdfPath) + '\n\n';
    } else if (audit && res.french_invoice_error) {
      new Notice(`[pdf2w] Not recognized as a French invoice: ${res.french_invoice_error}`);
      content += buildBasicFrontmatter(pdfPath) + '\n\n';
    }
    content += res.markdown;
    if (audit && res.french_invoice) content += buildAuditBlock(res.french_invoice);
    return { content, res };
  }

  /** Writes a dropped/picked PDF's bytes into the vault so `pdf_source` frontmatter links resolve, avoiding filename collisions. */
  async savePdfToVault(filename: string, buffer: ArrayBuffer, folder: string): Promise<string> {
    let path = folder ? `${folder}/${filename}` : filename;
    let i = 1;
    while (this.app.vault.getAbstractFileByPath(path)) {
      const base = filename.replace(/\.pdf$/i, '');
      path = folder ? `${folder}/${base}-${i}.pdf` : `${base}-${i}.pdf`;
      i++;
    }
    await this.app.vault.createBinary(path, buffer);
    return path;
  }

  async handlePdfToNote(file: TFile, opts: { audit: boolean }) {
    const start = Date.now();
    this.setStatus(`⚡ pdf2w: converting ${file.name}...`);
    try {
      const buffer = await this.app.vault.readBinary(file);
      const { content, res } = await this.buildNoteContent(file.name, buffer, file.path, opts.audit);
      const newPath = file.path.replace(/\.pdf$/i, '.md');
      const existing = this.app.vault.getAbstractFileByPath(newPath);
      if (existing instanceof TFile) await this.app.vault.modify(existing, content);
      else await this.app.vault.create(newPath, content);

      this.setStatus(`✔ pdf2w: done in ${Date.now() - start}ms`, 3000);
      const creditNote = res.credits_consumed ? ` · ${res.credits_consumed} credit${res.credits_consumed === 1 ? '' : 's'}` : '';
      new Notice(`✔ Converted to ${newPath}${creditNote}`);
    } catch (e: any) {
      this.setStatus('✖ pdf2w: error', 4000);
      new Notice(`✖ Conversion failed: ${e.message}`);
    }
  }

  promptPdfConversion(editor?: Editor, opts: { audit: boolean } = { audit: false }) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const start = Date.now();
      this.setStatus(`⚡ pdf2w: converting ${file.name}...`);
      try {
        const buffer = await file.arrayBuffer();
        const activeFile = this.app.workspace.getActiveFile();
        const folder = activeFile?.parent?.path ?? '';

        if (opts.audit || this.settings.createSeparateNote || !editor) {
          const pdfPath = await this.savePdfToVault(file.name, buffer, folder);
          const { content } = await this.buildNoteContent(file.name, buffer, pdfPath, opts.audit);
          const noteName = pdfPath.replace(/\.pdf$/i, '.md');
          await this.app.vault.create(noteName, content);
          this.setStatus(`✔ pdf2w: done in ${Date.now() - start}ms`, 3000);
          new Notice(`✔ Saved as ${noteName}`);
        } else {
          const res = await this.convert(file.name, buffer, { audit: false });
          editor.replaceSelection(res.markdown);
          this.setStatus(`✔ pdf2w: done in ${Date.now() - start}ms`, 3000);
          new Notice(`✔ Injected into active note!`);
        }
      } catch (err: any) {
        this.setStatus('✖ pdf2w: error', 4000);
        new Notice(`✖ Error: ${err.message}`);
      }
    };
    input.click();
  }

  async copyAuditAsTsv(file: TFile) {
    const content = await this.app.vault.read(file);
    const audit = extractAuditFromContent(content);
    if (!audit) {
      new Notice('[pdf2w] No invoice audit data found in this note — use "Convert & audit as French invoice" first.');
      return;
    }
    try {
      const tsv = await this.postJson('/v1/invoices/export/tsv', { audit });
      await navigator.clipboard.writeText(tsv);
      new Notice('✔ Invoice audit copied as TSV — paste into Excel/Sheets.');
    } catch (e: any) {
      new Notice(`✖ TSV export failed: ${e.message}`);
    }
  }

  async exportSingleFec(file: TFile) {
    const content = await this.app.vault.read(file);
    const audit = extractAuditFromContent(content);
    if (!audit) {
      new Notice('[pdf2w] No invoice audit data found in this note — use "Convert & audit as French invoice" first.');
      return;
    }
    const suggested = audit.invoice_number ? `AC${audit.invoice_number.replace(/\D/g, '').padStart(5, '0') || '00001'}` : 'AC00001';
    const ecritureNum = await new PromptModal(this.app, "Entry number (ecriture_num)", suggested).openAndGetValue();
    if (!ecritureNum) return;

    try {
      const fec = await this.postJson('/v1/invoices/export/fec', { audit, ecriture_num: ecritureNum });
      const fecPath = file.path.replace(/\.md$/i, '_FEC.txt');
      const existing = this.app.vault.getAbstractFileByPath(fecPath);
      if (existing instanceof TFile) await this.app.vault.modify(existing, fec);
      else await this.app.vault.create(fecPath, fec);
      new Notice(`✔ FEC entry written to ${fecPath}`);
    } catch (e: any) {
      new Notice(`✖ FEC export failed: ${e.message}`);
    }
  }

  async exportFolderToFec() {
    const active = this.app.workspace.getActiveFile();
    const folder = active?.parent;
    if (!folder) {
      new Notice('[pdf2w] Open a note inside the target folder first.');
      return;
    }

    const notes = this.app.vault.getMarkdownFiles().filter((f) => f.parent?.path === folder.path);
    const entries: { file: TFile; audit: FrenchInvoiceAudit }[] = [];
    for (const note of notes) {
      const content = await this.app.vault.read(note);
      const audit = extractAuditFromContent(content);
      if (audit) entries.push({ file: note, audit });
    }
    if (entries.length === 0) {
      new Notice(`[pdf2w] No audited invoices found in ${folder.path}.`);
      return;
    }

    // The service only exports one journal entry per call, each with its own
    // header row — batching means calling it per invoice and keeping only the
    // first response's header.
    const lines: string[] = [];
    const skipped: string[] = [];
    let i = 0;
    for (const { file, audit } of entries) {
      i++;
      const ecritureNum = `AC${String(i).padStart(5, '0')}`;
      try {
        const fec = await this.postJson('/v1/invoices/export/fec', { audit, ecriture_num: ecritureNum });
        const rows = fec.split('\n').filter((l) => l.length > 0);
        if (lines.length === 0) lines.push(...rows);
        else lines.push(...rows.slice(1));
      } catch (e: any) {
        skipped.push(`${file.basename}: ${e.message}`);
      }
    }

    if (lines.length === 0) {
      new Notice(`[pdf2w] Batch FEC export produced nothing (${skipped.length} skipped — see console).`);
      console.warn('[pdf2w] FEC batch export skipped:', skipped);
      return;
    }

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const outPath = `${folder.path}/FEC_export_${stamp}.txt`;
    const existingOut = this.app.vault.getAbstractFileByPath(outPath);
    const outContent = lines.join('\n') + '\n';
    if (existingOut instanceof TFile) await this.app.vault.modify(existingOut, outContent);
    else await this.app.vault.create(outPath, outContent);

    const skippedNote = skipped.length ? ` (${skipped.length} skipped — see console)` : '';
    new Notice(`✔ Exported ${entries.length - skipped.length}/${entries.length} invoices to ${outPath}${skippedNote}`);
    if (skipped.length) console.warn('[pdf2w] FEC batch export skipped:', skipped);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/** Minimal single-field text prompt, since Obsidian disallows window.prompt(). */
class PromptModal extends Modal {
  private value = '';
  private resolveFn: (v: string | null) => void = () => {};

  constructor(app: App, private title: string, private defaultValue: string) {
    super(app);
  }

  openAndGetValue(): Promise<string | null> {
    this.value = this.defaultValue;
    return new Promise((resolve) => {
      this.resolveFn = resolve;
      this.open();
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.title });
    const input = contentEl.createEl('input', { type: 'text', value: this.defaultValue });
    input.style.width = '100%';
    input.focus();
    input.select();

    const submit = () => {
      this.value = input.value.trim();
      this.close();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    new Setting(contentEl).addButton((btn) => btn.setButtonText('OK').setCta().onClick(submit));
  }

  onClose() {
    this.contentEl.empty();
    this.resolveFn(this.value || null);
  }
}

class Pdf2MdSettingTab extends PluginSettingTab {
  plugin: Pdf2MdPlugin;

  constructor(app: App, plugin: Pdf2MdPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'PDF to Markdown Converter Settings' });

    new Setting(containerEl)
      .setName('Converter Service URL')
      .setDesc('Local self-hosted endpoint (default: http://127.0.0.1:3984) or remote SaaS gateway.')
      .addText((text) =>
        text
          .setPlaceholder('http://127.0.0.1:3984')
          .setValue(this.plugin.settings.serviceUrl)
          .onChange(async (value) => {
            this.plugin.settings.serviceUrl = value.trim() || 'http://127.0.0.1:3984';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('API Key (Optional)')
      .setDesc('Bearer token for remote SaaS authentication or Keycloak-protected gateways.')
      .addText((text) =>
        text
          .setPlaceholder('Bearer / Keycloak token')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Create Separate Note on Drop')
      .setDesc('When dropping a PDF, create a new .md note instead of inserting into the active note.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.createSeparateNote).onChange(async (value) => {
          this.plugin.settings.createSeparateNote = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Detect tables via vector graphics')
      .setDesc('Adds ?vectors=1 to conversion requests — reconstructs tables from PDF drawing commands, not just text layout. More accurate on ruled tables, slightly slower.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.detectTables).onChange(async (value) => {
          this.plugin.settings.detectTables = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Auto-audit French invoices')
      .setDesc('Run the SIRET/TVA/reconciliation audit on every drag-and-drop or picker conversion, adding YAML frontmatter (adds the audit credit cost on the SaaS gateway). The right-click "Convert & audit" action always audits regardless of this setting.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoAuditInvoices).onChange(async (value) => {
          this.plugin.settings.autoAuditInvoices = value;
          await this.plugin.saveSettings();
        })
      );
  }
}
