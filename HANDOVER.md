# HANDOVER — AL-IRAQI Internal Business App (offline-first PWA)
Last updated: 2026-10-10 · App VER: v7 · DB_VER: 3
Owner's language: Egyptian Arabic (الرد بالعربي المصري).

## 1. Context & Rules
- Company: AL-IRAQI HOME APPLIANCES.
- Strict Policy: Offline-First, **No Hard Delete** (Audit Logs & Reversals Only).
- Stock Rule: Never drop stock below zero on reversal unless OverrideStock is enabled (and the user has that permission).
- Stock is a ledger: balance = sum of `movements.QuantityPieces`. Nothing edits a balance directly.

## 2. File tree (repo root `aliraqi-app/`)
- Root: `index.html`, `sw.js` (VER v7), `manifest.json`, `icon.svg`, `products.json`, `HANDOVER.md`
- css/: `app.css`, `invoice.css`
- js/: `app.js`, `auth.js`, `db.js`, `ui.js`, `products.js`, `stock.js`, `customers.js`, `invoices.js`, `invoice-pdf.js`, `scanner.js`, `help.js`, `jsQR.js`, `pdf-lib.min.js`, **`reversal.js` (new)**, **`stockdocs.js` (new)**
- fonts/: `invoice-regular.ttf`, `invoice-bold.ttf`

## 3. Audit Trail & Reversal System (v7)
### DB v3 (safe upgrade, no data touched)
New stores: `stock_docs` (DocID; idx Status, DateTime), `invoice_revisions` (RevisionID; idx InvoiceID), `credit_notes` (CreditNoteID; idx ParentInvoiceID), `credit_note_lines` (LineID; idx CreditNoteID, ParentInvoiceID).
- `postStockDoc` now also writes a `stock_docs` row (Number `SI-/SO-YYYYMMDD-DEV-0001`). Old docs (before v3) are rebuilt once from the `audit` log by `backfillStockDocs()` (Number suffix = first 4 chars of DocID, `Legacy:true`).
- `settings` keys used for numbering: `docseq:*`, `cnseq:*`, `invseq:*`.

### Movement types
`STOCK_IN`, `STOCK_OUT` (also invoice sale), `RETURN` (credit note, +), `INVOICE_ADJUST` (edit diff only), `VOID_REVERSAL` (exact opposite of an original movement, `ReversalOf` = original MovementID).

### Operations (all in `js/reversal.js`, each = ONE IndexedDB transaction: document + movements + syncq + audit)
| Function | Permission | Rules |
|---|---|---|
| `voidInvoice` | CancelInvoice | reason required; blocked if invoice already VOID or has ANY credit note; writes VOID_REVERSAL for every original movement (sale + adjusts); `Status='VOID'`, VoidedAt/By/Reason |
| `voidStockDoc` | VoidStockDoc | reason required; voiding a STOCK_IN checks warehouse balance per product → `INSUFFICIENT` (unless allowNegative + OverrideStock) |
| `createCreditNote` | CreateReturn | partial/full per line, qty ≤ sold − already returned, sold price, returns to the SAME warehouse as the invoice, number `CN-YYYYMMDD-DEV-0001`, `ParentInvoiceID` |
| `editInvoice` | EditInvoice | reason required; blocked only if VOID. **Allowed even with returns**: new qty per product must be ≥ already-returned qty (net ≥ 0, `BELOW_RETURNED`), a returned product can't be removed. Snapshot of old version → `invoice_revisions`; kept products keep the same `LineID` (so old credit notes stay linked), removed products flagged `Superseded:true` (never deleted); same Number, `Version+1`; only the DIFF per product goes to stock (`INVOICE_ADJUST`), increases are balance-checked |

Read helpers: `liveLines(invoiceId)` (ignores Superseded lines — ALWAYS use it, not a raw index read), `returnedByLine(invoiceId)`.

### UI
- Invoice view (INTERNAL screens only): badges «ملغاة» / «معدّلة · نسخة N» / «عليها مرتجع»; buttons تعديل / مرتجع / إلغاء (by permission); credit-note list; revision history with preview of old versions.
- Invoices list has a switch الفواتير | المرتجعات.
- `invoice-pdf.js`: red rotated «ملغاة» stamp on every page when `Status==='VOID'`; **no «معدّلة»/Version anywhere in the customer PDF**; credit notes (`DocKind:'CREDIT'`) render as «إشعار مرتجع» with «عن فاتورة <number>».
- New tile «مستندات المخزن» (ViewStock) → `stockdocs.js`: list/filter, details with movements, void button (VoidStockDoc).
- `ui.js` gained `modal()` and `askReason()` (reason ≥ 3 chars).

## 4. Permissions (auth.js)
- New perm `VoidStockDoc`.
- STAFF (Ahmed, Nour) keep `OverrideStock` (field work, decided by owner) but no longer have: ManageUsers, EditInvoice, CancelInvoice, CreateReturn, OverridePrice, ChangeDefaultPrice, VoidStockDoc. MANAGER/OWNER keep them.
- `refreshRoles()` runs on every boot and rewrites the stored roles from code (needed because roles were seeded once). If a Roles-editing screen is built later, remove/adjust this.
- **Owner protection (strict):** `saveUser(actor,target)` and `changePin(user,pin,actor)` re-read actor/target from the DB and refuse (`USER_PROTECTED`) any write on an OWNER account (data, permissions, PIN, or promoting someone to OWNER) unless the actor's stored role is OWNER. `can()` ignores DeniedPerms for OWNER. Any future users/roles screen MUST write through `saveUser` only. `ManageUsers` is now MANAGER/OWNER only (removed from STAFF); the guard still protects Karim from MANAGER too.

## 5. Open questions / decisions to confirm
1. Credit notes are not voidable (no spec). Therefore an invoice that ever got a return can never be voided (it can still be edited above the returned qty).
2. Sync (Apps Script) must treat `Superseded` lines + `invoice_revisions` + `Version` correctly; sync is not built yet.

## 6. Manual test checklist (on device, offline)
1. Open app once online (SW v7 installs; DB upgrades to v3). Stock docs screen shows old docs as Legacy.
2. Receive 10 → void it → balance back to previous; stock history shows `عكس إلغاء`.
3. Receive 10, sell 8 via invoice, void the receive → must be blocked (INSUFFICIENT).
4. Invoice: edit qty/price/add/remove line → Version 2, same number, stock changed by diff only, old version viewable in history.
5. Invoice: return part → CN created, stock +, PDF titled إشعار مرتجع; void → blocked; edit → allowed, but lowering a product below its returned qty → blocked; PDF of the edited invoice has no «معدّلة».
6. Invoice without returns: void → stamp on preview + PDF, stock restored.
7. Log in as Ahmed/Nour → no edit/return/cancel/void buttons.
