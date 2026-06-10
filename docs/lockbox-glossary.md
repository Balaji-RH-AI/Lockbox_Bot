# Lockbox Implementation — Glossary & Help

Starter reference for the Help assistant. Replace/expand with your authoritative documentation.

## Lockbox types
- **Wholesale (Standard) Lockbox** — deposit-only processing of business-to-business payments: payments are opened, imaged, deposited (ICL), archived, and standard reports are produced. Choose this for high-value, low-volume B2B checks where no keying of remittance data is needed.
- **Add Data Entry to Standard box** — adds keyed capture of remittance fields (invoice number, customer number, amounts, etc.) on top of a standard wholesale box.
- **Wholetail / Retail Lockbox** — for high-volume consumer payments that arrive with a remittance coupon (OCR scanline) and/or require data entry; supports transmission of captured data. Choose this when payments come with scannable coupons.

## Common terms
- **DDA (Demand Deposit Account)** — the bank account number where deposited funds are credited. Numeric only, 1–20 digits.
- **RT / Routing Number (ABA)** — the 9-digit bank routing/transit number identifying the financial institution.
- **PO Box / Lockbox Number** — the dedicated postal box mail is sent to for the lockbox; a lockbox number is assigned by the bank.
- **ICL (Image Cash Letter)** — electronic deposit of check images instead of physical checks.
- **Legal line vs Courtesy box** — on a check, the *legal line* is the written-out amount; the *courtesy box* is the numeric amount. If they differ, processing rules decide which to use.
- **Payee verification** — whether the lockbox accepts checks made out to any payee or only an approved payee list.

## Exception handling
For each exception type you choose **Accept & Deposit** or **Return Unprocessed**:
- **Blank Payee** — check has no payee name.
- **Blank Legal Line** — written amount missing.
- **Third Party Checks** — check payable to a different party and endorsed over.
- **Missing Signature** — unsigned check.
- **Post Dated / Stale Dated** — dated in the future / older than ~6 months.
- **"Paid in Full" Items** — annotations claiming full settlement (handled best-effort).
- **Foreign Checks** — drawn on non-US banks.

## Reporting
- **On-Demand Reports** — available any time in the web portal (Batch Summary, Batch Detail, Check Detail).
- **Emailed Reports** — for security, only Batch Summary or No-Activity reports are emailed.
- **Scheduled Reports** — end-of-day reports published to the portal after the box cutoff (e.g. Deposit Summary, Image Detail).
- **No Activity Report** — notification that no mail was received that day.

## Data entry
- **Check digit** — a validation digit appended to an account number (e.g. Mod 10 / Mod 11) used to verify keying accuracy.
- **Check & List payment** — a single check accompanied by a list allocating it across multiple accounts/invoices; may require balancing.
- **Lockbox Exceptions module** — a web-portal feature letting the customer review and supply missing info for exception payments before processing.

## Remittance coupon / OCR
- **Scanline** — the machine-readable OCR line on a remittance coupon encoding account/invoice/amount fields. **OCR-A** font is recommended.
- **Mark sense detection** — flags coupons where the customer marked address changes or other options.

## Transmission files
- **BAI format** — a standard bank file layout for delivering payment data.
- **SFTP Push vs Pull** — *Push*: the bank sends the file to you (needs your User ID/Password). *Pull*: you retrieve it from the bank (needs your IP address).
- **Positive / Lookup / Stop file (inbound)** — files you send the lockbox to validate accounts, look up customer data, or stop processing certain items.

## Go-live
An estimated live date is provided after Lockbox Programming and Operations review the scope. Providing complete requirements up front avoids changes during implementation.
