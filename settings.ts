// Obsidian UI for the pdf2w plugin: the small text-prompt modal and the
// settings tab. Split out of main.ts to keep every plugin file under the
// 500-line code-quality limit.
import { App, Modal, PluginSettingTab, Setting } from 'obsidian';
import type Pdf2MdPlugin from './main';

/** Minimal single-field text prompt, since Obsidian disallows window.prompt(). */
export class PromptModal extends Modal {
  private value = '';
  private submitted = false;
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
      this.submitted = true;
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
    this.resolveFn(this.submitted ? this.value || null : null);
  }
}

export class Pdf2MdSettingTab extends PluginSettingTab {
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

    new Setting(containerEl)
      .setName('Debug logging')
      .setDesc('Append a trace of every request/response to a "pdf2w-debug.log.md" note at your vault root — open it in Obsidian to see exactly what was sent and what the server returned (useful for diagnosing e.g. why an invoice audit did or did not run). Off by default; the log file is never created unless this is on.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debugMode).onChange(async (value) => {
          this.plugin.settings.debugMode = value;
          await this.plugin.saveSettings();
        })
      );
  }
}
