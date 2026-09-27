import { Editor, MarkdownView, Notice, Plugin, TFile, requestUrl } from 'obsidian';
import {
  DEFAULT_SETTINGS,
  buildAuditBlock,
  buildBasicFrontmatter,
  buildInvoiceFrontmatter,
  extractAuditFromContent,
} from './core';
import type { ConvertResponse, FrenchInvoiceAudit, Pdf2MdSettings } from './core';
import { Pdf2MdSettingTab, PromptModal } from './settings';

// A freePath() pick is a check-then-create: two conversions racing can pick the
// same path and the loser's vault.create rejects with "already exists". Retry
// that many times, each retry re-picking the next free sibling.
const FREE_PATH_MAX_ATTEMPTS = 10;

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
        this.promptPdfConversion({ audit: false });
      },
    });

    // 2b. Command Palette: convert + audit as French invoice (always a separate note)
    this.addCommand({
      id: 'convert-pdf-and-audit-invoice',
      name: 'Convert PDF and audit as French invoice',
      callback: () => this.promptPdfConversion({ audit: true }),
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
      this.app.workspace.on('editor-drop', async (evt: DragEvent, _editor: Editor, view: MarkdownView) => {
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
            await this.debugLog(`drop: ${file.name} | autoAuditInvoices=${audit} | detectTables=${this.settings.detectTables}`);
            const folder = view.file?.parent?.path ?? '';
            const pdfPath = await this.savePdfToVault(file.name, buffer, folder);
            const { content } = await this.buildNoteContent(file.name, buffer, pdfPath, audit);
            const noteName = await this.createAtFreePath(pdfPath.replace(/\.pdf$/i, '.md'), content);
            new Notice(`[pdf2w] Created ${noteName}!`);
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

  /** Appends a timestamped line to a vault-root debug log note, when Debug logging is enabled. Best-effort: a logging failure must never break a conversion. */
  async debugLog(message: string) {
    if (!this.settings.debugMode) return;
    console.log(`[pdf2w:debug] ${message}`);
    const line = `[${new Date().toISOString()}] ${message}\n`;
    const path = 'pdf2w-debug.log.md';
    try {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await this.app.vault.append(existing, line);
      } else {
        await this.app.vault.create(path, line);
      }
    } catch {
      // Best-effort — logging must never break a conversion.
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
      // Both servers PathUnescape X-File-Name and dev_ui's infra/api.js encodes
      // it; sending the raw name would silently rewrite a `%XX` or non-ASCII
      // filename on arrival.
      'X-File-Name': encodeURIComponent(filename),
    };
    if (this.settings.apiKey.trim()) headers['Authorization'] = `Bearer ${this.settings.apiKey.trim()}`;

    await this.debugLog(`convert() → POST ${url} | filename=${filename} | audit_requested=${opts.audit} | vectors=${this.settings.detectTables}`);
    const response = await requestUrl({ url, method: 'POST', headers, body: data, throw: false });
    const text = response.text;
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Unexpected response (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
    await this.debugLog(`convert() ← HTTP ${response.status} | ok=${json.ok} | engine=${json.engine ?? 'n/a'} | pages=${json.pages ?? 'n/a'} | credits_consumed=${json.credits_consumed ?? 'n/a'} | french_invoice=${json.french_invoice ? 'present' : 'absent'} | french_invoice_error=${json.french_invoice_error ?? 'none'} | error=${json.error ?? 'none'}`);
    if (response.status < 200 || response.status >= 300 || json.ok === false) {
      throw new Error(json.error || `HTTP ${response.status}`);
    }
    return json as ConvertResponse;
  }

  /** POST a JSON body to a service path and return the raw text response (used by the TSV/FEC export endpoints). */
  async postJson(path: string, body: unknown): Promise<string> {
    const base = this.settings.serviceUrl.replace(/\/$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.settings.apiKey.trim()) headers['Authorization'] = `Bearer ${this.settings.apiKey.trim()}`;

    await this.debugLog(`postJson() → POST ${base}${path}`);
    const response = await requestUrl({ url: `${base}${path}`, method: 'POST', headers, body: JSON.stringify(body), throw: false });
    const text = response.text;
    await this.debugLog(`postJson() ← HTTP ${response.status} | body=${text.slice(0, 300)}`);
    if (response.status < 200 || response.status >= 300) {
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
    await this.debugLog(`buildNoteContent(): audit=${audit} | french_invoice=${!!res.french_invoice} | french_invoice_error=${res.french_invoice_error ?? 'none'}`);
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

  /** Returns `path` if free, else the first free `name 1.ext`, `name 2.ext`, … sibling. Never overwrites. */
  freePath(path: string): string {
    if (!this.app.vault.getAbstractFileByPath(path)) return path;
    const dot = path.lastIndexOf('.');
    const base = dot > 0 ? path.slice(0, dot) : path;
    const ext = dot > 0 ? path.slice(dot) : '';
    let i = 1;
    let candidate = `${base} ${i}${ext}`;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      i++;
      candidate = `${base} ${i}${ext}`;
    }
    return candidate;
  }

  /**
   * Creates `content` at the first free path near `preferredPath`. freePath() is
   * a check-then-create, so a concurrent conversion can win the race between the
   * pick and the create; that "already exists" rejection re-picks the next free
   * sibling of `preferredPath` (keeping the canonical `name 1`, `name 2` … order),
   * bounded by FREE_PATH_MAX_ATTEMPTS. Any other error propagates.
   */
  async createAtFreePath(preferredPath: string, content: string): Promise<string> {
    let candidate = this.freePath(preferredPath);
    for (let attempt = 1; attempt <= FREE_PATH_MAX_ATTEMPTS; attempt++) {
      try {
        await this.app.vault.create(candidate, content);
        return candidate;
      } catch (e: any) {
        const lostRace = /already exists/i.test(String(e?.message ?? e));
        if (!lostRace || attempt === FREE_PATH_MAX_ATTEMPTS) throw e;
        candidate = this.freePath(preferredPath);
      }
    }
    throw new Error(`[pdf2w] could not allocate a free path near ${preferredPath}`);
  }

  async handlePdfToNote(file: TFile, opts: { audit: boolean }) {
    const start = Date.now();
    this.setStatus(`⚡ pdf2w: converting ${file.name}...`);
    try {
      const buffer = await this.app.vault.readBinary(file);
      const { content, res } = await this.buildNoteContent(file.name, buffer, file.path, opts.audit);
      const newPath = await this.createAtFreePath(file.path.replace(/\.pdf$/i, '.md'), content);
      this.setStatus(`✔ pdf2w: done in ${Date.now() - start}ms`, 3000);
      const creditNote = res.credits_consumed ? ` · ${res.credits_consumed} credit${res.credits_consumed === 1 ? '' : 's'}` : '';
      new Notice(`✔ Converted to ${newPath}${creditNote}`);
    } catch (e: any) {
      this.setStatus('✖ pdf2w: error', 4000);
      new Notice(`✖ Conversion failed: ${e.message}`);
    }
  }

  promptPdfConversion(opts: { audit: boolean } = { audit: false }) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const audit = opts.audit || this.settings.autoAuditInvoices;
      const start = Date.now();
      this.setStatus(`⚡ pdf2w: converting ${file.name}...`);
      try {
        const buffer = await file.arrayBuffer();
        const activeFile = this.app.workspace.getActiveFile();
        const folder = activeFile?.parent?.path ?? '';
        await this.debugLog(`picker: ${file.name} | audit_requested=${audit} | detectTables=${this.settings.detectTables}`);

        const pdfPath = await this.savePdfToVault(file.name, buffer, folder);
        const { content } = await this.buildNoteContent(file.name, buffer, pdfPath, audit);
        const noteName = await this.createAtFreePath(pdfPath.replace(/\.pdf$/i, '.md'), content);
        this.setStatus(`✔ pdf2w: done in ${Date.now() - start}ms`, 3000);
        new Notice(`✔ Saved as ${noteName}`);
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
      const fecPath = await this.createAtFreePath(file.path.replace(/\.md$/i, '_FEC.txt'), fec);
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
    const outContent = lines.join('\n') + '\n';
    const outPath = await this.createAtFreePath(`${folder.path}/FEC_export_${stamp}.txt`, outContent);

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
