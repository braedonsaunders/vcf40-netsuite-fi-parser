const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
const parserPath = path.join(repoRoot, 'FileCabinet', 'SuiteScripts', 'vcf40_fi_parser.js');
const usingDefaultFixture = !process.argv[2];
const samplePath = process.argv[2] || path.join(repoRoot, 'test', 'fixtures', 'minimal_vcf40_sample.tsv');

function loadSuiteScript(filePath) {
  const code = fs.readFileSync(filePath, 'utf8');
  let exported;
  const sandbox = {
    console,
    define(dependencies, factory) {
      exported = factory();
    }
  };

  vm.runInNewContext(code, sandbox, { filename: filePath });
  assert(exported, 'SuiteScript module did not call define().');
  return exported;
}

function createMockContext(contents, options = {}) {
  const accounts = [];
  const errors = [];
  const expenseCodes = [];
  const transactionCodes = [];
  const inputData = options.iteratorOnly ? {
    lines: {
      iterator() {
        const lines = String(contents || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        let index = 0;
        return {
          each(callback) {
            while (index < lines.length) {
              const keepGoing = callback({ value: lines[index] });
              index += 1;
              if (keepGoing === false) {
                return false;
              }
            }
            return true;
          }
        };
      }
    }
  } : {
    getContents() {
      return contents;
    }
  };

  return {
    accounts,
    errors,
    expenseCodes,
    transactionCodes,
    inputData,
    createAccountData(options) {
      assert(options.cardHolder || options.employeeId, 'Corporate card account data should include a cardholder or employee ID.');

      const account = {
        options,
        transactions: [],
        createNewTransaction(transaction) {
          assert(transaction.date, 'Transaction date is required.');
          assert.strictEqual(typeof transaction.amount, 'number', 'Transaction amount must be numeric.');
          assert(transaction.uniqueId, 'Transaction uniqueId is required for duplicate detection.');
          assert(transaction.expenseCode, 'Corporate card expenseCode is required.');
          assert(transaction.additionalFields.billedCurrencyISOCode, 'Corporate card billedCurrencyISOCode is required.');
          this.transactions.push(transaction);
        }
      };

      accounts.push(account);
      return account;
    },
    createNewExpenseCode(options) {
      assert(options.code, 'NetSuite createNewExpenseCode() expects options.code.');
      assert(!options.expenseCode, 'Use options.code, not options.expenseCode.');
      expenseCodes.push(options);
    },
    createNewStandardTransactionCode(options) {
      assert(options.transactionCode, 'transactionCode is required.');
      assert(options.transactionType, 'transactionType is required.');
      transactionCodes.push(options);
    },
    addError(options) {
      errors.push(options);
    }
  };
}

function centsTotal(transactions) {
  return transactions.reduce((total, transaction) => total + Math.round(Number(transaction.amount) * 100), 0);
}

const parser = loadSuiteScript(parserPath);
const sample = fs.readFileSync(samplePath, 'utf8');
const context = createMockContext(sample);

parser.getExpenseCodes(context);
parser.getStandardTransactionCodes(context);
parser.parseData(context);

const transactions = context.accounts.flatMap((account) => account.transactions);
const account = context.accounts[0];

assert.strictEqual(context.errors.length, 0, 'Parser emitted unexpected errors.');
assert.strictEqual(context.expenseCodes.length, 11, 'Expected built-in expense code buckets.');
assert(context.expenseCodes.some((expenseCode) => expenseCode.code === 'VCF_OFFICE'), 'Expected VCF_OFFICE expense code.');
assert.strictEqual(context.transactionCodes.length, 2, 'Expected charge and credit transaction codes.');
assert(context.accounts.length > 0, 'Expected at least one card account.');
assert(transactions.length > 0, 'Expected at least one T5 card transaction.');
assert.strictEqual(
  new Set(transactions.map((transaction) => transaction.uniqueId)).size,
  transactions.length,
  'Expected unique transaction IDs.'
);

if (usingDefaultFixture) {
  const iteratorContext = createMockContext(sample, { iteratorOnly: true });
  parser.parseData(iteratorContext);

  assert.strictEqual(iteratorContext.accounts.length, 1, 'Expected iterator input to parse one card account.');
  assert.strictEqual(
    iteratorContext.accounts.flatMap((parsedAccount) => parsedAccount.transactions).length,
    2,
    'Expected iterator input to parse two card transactions.'
  );

  assert.strictEqual(context.accounts.length, 1, 'Expected one card account.');
  assert.strictEqual(account.options.cardHolder, 'AVERY PARK');
  assert.strictEqual(account.options.employeeId, 'E1001');
  assert.strictEqual(transactions.length, 2, 'Expected two T5 card transactions.');
  assert.strictEqual(centsTotal(transactions), 10000, 'Expected signed transaction total of $100.00.');
  assert.strictEqual(transactions[0].expenseCode, 'VCF_OFFICE');
  assert.strictEqual(transactions[0].currency, 'CAD');
  assert.strictEqual(transactions[0].additionalFields.billedCurrencyISOCode, 'CAD');
  assert.strictEqual(transactions[1].amount, -23.45);
  assert.strictEqual(transactions[1].transactionTypeCode, 'CREDIT');
}

console.log(JSON.stringify({
  sample: samplePath,
  accounts: context.accounts.length,
  transactions: transactions.length,
  signedTotal: (centsTotal(transactions) / 100).toFixed(2),
  accountsWithoutEmployeeId: context.accounts.filter((parsedAccount) => !parsedAccount.options.employeeId).length,
  firstAccount: usingDefaultFixture ? account.options : undefined,
  firstTransaction: usingDefaultFixture ? transactions[0] : undefined
}, null, 2));
