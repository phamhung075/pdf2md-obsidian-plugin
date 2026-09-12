# Obsidian PDF to Markdown Converter (`obsidian-pdf2md`)

> **Sub-Millisecond PDF to Markdown with 2D Table Reconstruction for Obsidian PKM**  
> Local-First Privacy • Zero Cloud Leaks • Pristine GitHub Flavored Markdown Pipe Tables

Convert any PDF document directly into clean, editable Markdown within your Obsidian vault.

## Features

- **Drag-and-Drop Ingestion:** Simply drag any PDF file directly into your active note to convert and inject clean Markdown at your cursor position.
- **Pristine Table Formatting:** Reconstructs complex tables into formatted GitHub-flavored pipe tables (`| Col 1 | Col 2 |`).
- **Local & Self-Hosted First:** Connects directly to your local microservice container on `http://127.0.0.1:3984` (or custom port) — 100% offline and free.
- **Optional Cloud Gateway:** Supports remote SaaS API keys with Keycloak bearer tokens.
- **Context Menu Actions:** Right-click any PDF in the vault file tree to either convert it plainly or convert **and audit it as a French invoice**.
- **French Invoice Auditing:** Runs the SIRET (Luhn) / TVA intracommunautaire (mod-97) checksum and HT+TVA=TTC reconciliation, then writes the result as YAML frontmatter (`invoice_no`, `siret`, `total_ht/tva/ttc`, `reconciled`, `pdf_source`, …) so the note is immediately queryable with Dataview.
- **Copy as Excel TSV:** `Copy invoice audit as Excel TSV` command pastes a French-locale TSV (comma decimals, no currency symbols) straight into Excel/Sheets.
- **FEC Export:** `Export invoice audit to FEC (.txt)` writes one balanced journal entry per note; `Export folder invoices to FEC (batch)` merges every audited invoice in the current folder into one FEC journal file — ready for Cegid/Sage/Odoo import.
- **Status Bar Progress:** A status bar pill shows live conversion progress and elapsed time.

### How the audit data is stored

Auditing a PDF creates a note with YAML frontmatter plus a hidden `%%pdf2w-audit ... %%` comment block holding the raw audit JSON. The TSV/FEC export commands read that block instead of re-calling the audit endpoint, so exporting doesn't re-spend audit credits. Only notes created by "Convert & audit as French invoice" carry this block.

## Development & Building

```bash
cd plugins/obsidian
npm install
npm run build
```

Copy `main.js` and `manifest.json` into your vault's `.obsidian/plugins/pdf2md-converter/` directory.

## License

MIT License.
