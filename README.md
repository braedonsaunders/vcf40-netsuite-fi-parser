# VCF 4.0 NetSuite FI Parser

An unofficial NetSuite Financial Institution Parser plug-in for Visa Commercial Format (VCF) 4.0 corporate card files.

The parser reads VCF 4.0 variable-length tab-delimited files, links card transactions (T5) to card accounts (T3) and cardholders (T4), and emits NetSuite `createAccountData()` / `createNewTransaction()` records for Corporate Card Expenses format profiles.

## What It Does

- Parses VCF 4.0 tab-delimited transaction-set files.
- Imports T5 Card Transaction records as NetSuite corporate card transactions.
- Uses T3 Card Account and T4 Cardholder records for cardholder and employee matching.
- Converts VCF `MMDDCCYY` dates to NetSuite ISO `YYYY-MM-DD`.
- Converts implied-decimal VCF amounts to NetSuite numbers.
- Signs credit transaction types as negative amounts.
- Maps numeric ISO currency codes such as `124` and `840` to `CAD` and `USD`.
- Provides a small MCC-to-expense-code bucket map for NetSuite expense category mapping.

## Not Included

- PGP decryption.
- SFTP connectivity.
- Bank-specific delivery setup.
- Real VCF sample files or Visa specification material.

Keep those outside this repository. VCF files can contain cardholder names, employee identifiers, and card/account numbers.

## Files

- `FileCabinet/SuiteScripts/vcf40_fi_parser.js` - SuiteScript 2.0 Financial Institution Parser plug-in.
- `test/vcf40_fi_parser.test.js` - local Node.js test harness that mocks the NetSuite parser context.
- `test/fixtures/minimal_vcf40_sample.tsv` - synthetic tab-delimited VCF-style fixture.

## NetSuite Setup

1. Upload `FileCabinet/SuiteScripts/vcf40_fi_parser.js` to the NetSuite File Cabinet.
2. Create a new Financial Institution Parser Plug-in implementation using that script.
3. Create or update a Financial Institution format profile.
4. Select the parser implementation for the Transaction Parser.
5. For employee expense workflows, use a Corporate Card Expenses profile.
6. Map the `VCF_*` expense codes to NetSuite expense categories.
7. Configure employee matching by `employeeId` when your VCF T4 Employee ID values match NetSuite external employee IDs. Otherwise, match by cardholder name or customize `createAccountData()`.

Oracle's docs confirm that corporate card imports use the Financial Institution Parser Plug-in interface and that `createNewTransaction()` must include `additionalFields.billedCurrencyISOCode` for corporate card data:

- [Financial Institution Parser Plug-in overview](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_159077938079.html)
- [Financial Institution Parser interface definition](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_159078912850.html)
- [Importing corporate card data](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/subsect_162885823036.html)

## Local Test

```powershell
npm test
```

Expected fixture result:

- `1` card account.
- `2` card transactions.
- Signed total: `$100.00`.
- One charge and one credit transaction.

You can run the harness against your own decrypted VCF file:

```powershell
node test/vcf40_fi_parser.test.js C:\path\to\decrypted-vcf-file.tsv
```

Do not commit real customer files.

## Customizing Expense Codes

The parser returns broad `VCF_*` expense code buckets from `getExpenseCodes()` and maps MCCs in `expenseCodeForMcc()`.

If you want one expense code per MCC, replace the bucket map with raw MCC codes and update `getExpenseCodes()`. If you want company-specific expense categories, keep the parser generic and do the mapping in the NetSuite format profile where possible.

## Notes

- This project is not affiliated with Visa, Oracle NetSuite, or any issuer.
- The synthetic test fixture is intentionally tiny and does not replace certification against your issuer's real feed.
- The parser is written as SuiteScript 2.0 because NetSuite's Financial Institution Parser Plug-in SDF support requires SuiteScript 2.0.
