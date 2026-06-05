/**
 * Visa Commercial Format (VCF) 4.0 Financial Institution Parser for NetSuite.
 *
 * @NApiVersion 2.x
 * @NScriptType FIParserPlugin
 * @NModuleScope TargetAccount
 */
define(['N/log', 'N/error'], function (log, nsError) {
    var BANK_IMPORT_STANDARD_ERROR = 'BANK_IMPORT_STANDARD_ERROR';
    var UNKNOWN_PARSE_ERROR = '1000000000';

    var CREDIT_TRANSACTION_TYPES = {
        '11': true,
        '30': true,
        '31': true,
        '61': true,
        '63': true,
        '65': true,
        '71': true,
        '73': true
    };

    var ISO_NUMERIC_TO_ALPHA = {
        '036': 'AUD',
        '124': 'CAD',
        '156': 'CNY',
        '344': 'HKD',
        '392': 'JPY',
        '484': 'MXN',
        '554': 'NZD',
        '756': 'CHF',
        '826': 'GBP',
        '840': 'USD',
        '978': 'EUR'
    };

    var EXPENSE_CODES = [
        { code: 'VCF_AIR', description: 'Airfare' },
        { code: 'VCF_AUTO', description: 'Auto and Rental' },
        { code: 'VCF_FUEL', description: 'Fuel' },
        { code: 'VCF_LODGING', description: 'Lodging' },
        { code: 'VCF_MEALS', description: 'Meals' },
        { code: 'VCF_OFFICE', description: 'Office and Supplies' },
        { code: 'VCF_PROFESSIONAL', description: 'Professional Services' },
        { code: 'VCF_RETAIL', description: 'Retail' },
        { code: 'VCF_SHIPPING', description: 'Shipping' },
        { code: 'VCF_TELECOM', description: 'Telecom and Utilities' },
        { code: 'VCF_MISC', description: 'Miscellaneous' }
    ];

    var STRUCTURE_RECORD_FIELD_COUNT = 16;
    var RECORD_BOUNDARY_MARKERS = {
        '3': true,
        '4': true,
        '6': true,
        '7': true,
        '8': true,
        '9': true
    };

    var VCF_RECORD_FIELD_COUNTS = {
        '1': 35,
        '2': 37,
        '3': 47,
        '4': 35,
        '5': 76,
        '6': 21,
        '7': 34,
        '8': 32,
        '9': 37,
        '10': 33,
        '11': 11,
        '14': 36,
        '15': 33,
        '17': 53,
        '18': 19,
        '20': 33,
        '21': 33,
        '26': 33,
        '27': 16,
        '28': 23,
        '29': 12,
        '30': 12,
        '31': 23
    };

    function parseData(context) {
        try {
            parseDataInternal(context);
        } catch (e) {
            logParserFailure('VCF parseData failed', e);
            addParserError(context, UNKNOWN_PARSE_ERROR, '1', '1');
            throw createStandardError(UNKNOWN_PARSE_ERROR);
        }
    }

    function parseDataInternal(context) {
        var contents = getInputContents(context);
        var parsed = parseVcf(contents);
        var accountDataByAccountNumber = {};
        var accountCount = 0;
        var i;

        logParserAudit('VCF parse summary', {
            accounts: objectCount(parsed.accounts),
            cardholders: objectCount(parsed.cardholders),
            transactions: parsed.transactions.length
        });

        if (parsed.transactions.length === 0) {
            throw new Error('No VCF T5 Card Transaction records were found in the input file.');
        }

        for (i = 0; i < parsed.transactions.length; i += 1) {
            var transaction = parsed.transactions[i];
            var accountNumber = transaction.accountNumber;
            var account = parsed.accounts[accountNumber] || {};
            var cardholder = parsed.cardholders[account.cardholderId] || {};
            var accountData = accountDataByAccountNumber[accountNumber];

            validateParsedTransaction(transaction);

            if (!accountData) {
                logParserAudit('VCF account data create', {
                    accountId: accountLinkingId(accountNumber, account),
                    accountLast4: lastFour(accountNumber)
                });
                accountData = createAccountData(context, accountNumber, account, cardholder);
                accountDataByAccountNumber[accountNumber] = accountData;
                accountCount += 1;
            }

            accountData.createNewTransaction(toNetSuiteTransaction(transaction, account, cardholder));
        }

        logParserAudit('VCF import objects created', {
            accounts: accountCount,
            transactions: parsed.transactions.length
        });
    }

    function getExpenseCodes(context) {
        var i;
        for (i = 0; i < EXPENSE_CODES.length; i += 1) {
            context.createNewExpenseCode({
                code: EXPENSE_CODES[i].code,
                description: EXPENSE_CODES[i].description
            });
        }
    }

    function getStandardTransactionCodes(context) {
        context.createNewStandardTransactionCode({
            transactionCode: 'CHARGE',
            transactionType: 'DEBIT',
            description: 'VCF commercial card charge'
        });
        context.createNewStandardTransactionCode({
            transactionCode: 'CREDIT',
            transactionType: 'CREDIT',
            description: 'VCF commercial card credit'
        });
    }

    function getInputContents(context) {
        var inputData;
        var lines;

        if (!context || !context.inputData) {
            throw new Error('Missing NetSuite inputData.');
        }

        inputData = context.inputData;

        if (typeof inputData.getContents === 'function') {
            return inputData.getContents();
        }

        if (inputData.lines && typeof inputData.lines.iterator === 'function') {
            lines = [];
            inputData.lines.iterator().each(function (line) {
                lines.push(String(line.value || ''));
                return true;
            });
            return lines.join('\n');
        }

        throw new Error('Missing NetSuite inputData contents.');
    }

    function createAccountData(context, accountNumber, account, cardholder) {
        return context.createAccountData({
            accountId: accountLinkingId(accountNumber, account)
        });
    }

    function validateParsedTransaction(transaction) {
        if (!transaction.accountNumber) {
            throw new Error('VCF T5 transaction is missing account number at parsed line ' + transaction.lineNumber + '.');
        }
        if (!transaction.transactionDate && !transaction.postingDate) {
            throw new Error('VCF T5 transaction is missing usable transaction/posting date for account ' + lastFour(transaction.accountNumber) + '.');
        }
        if (!transaction.transactionReferenceNumber && !transaction.sequenceNumber) {
            throw new Error('VCF T5 transaction is missing both transaction reference number and sequence number for account ' + lastFour(transaction.accountNumber) + '.');
        }
        if (!transaction.billingCurrencyCode && !transaction.sourceCurrencyCode) {
            throw new Error('VCF T5 transaction is missing billing/source currency for account ' + lastFour(transaction.accountNumber) + '.');
        }
    }

    function parseVcf(contents) {
        var rows = splitRows(contents);
        var currentBlockType = '';
        var cardholders = {};
        var accounts = {};
        var transactions = [];
        var i;

        for (i = 0; i < rows.length; i += 1) {
            var row = rows[i];
            if (!row || row.length === 0 || isBlankRow(row)) {
                continue;
            }

            var marker = clean(row[0]);
            if (marker === '8') {
                currentBlockType = clean(row[4]);
                continue;
            }

            if (marker === '9') {
                currentBlockType = '';
                continue;
            }

            if (marker === '6' || marker === '7' || !currentBlockType) {
                continue;
            }

            if (currentBlockType === '3') {
                var account = parseCardAccount(row);
                if (account.accountNumber) {
                    accounts[account.accountNumber] = account;
                }
            } else if (currentBlockType === '4') {
                var cardholder = parseCardholder(row);
                if (cardholder.cardholderId) {
                    cardholders[cardholder.cardholderId] = cardholder;
                }
            } else if (currentBlockType === '5') {
                transactions.push(parseCardTransaction(row, i + 1));
            }
        }

        return {
            accounts: accounts,
            cardholders: cardholders,
            transactions: transactions
        };
    }

    function parseCardAccount(row) {
        return {
            cardholderId: clean(row[1]),
            accountNumber: clean(row[2]),
            hierarchyNode: clean(row[3]),
            billingAccountNumber: clean(row[14]),
            costCenter: clean(row[15])
        };
    }

    function parseCardholder(row) {
        return {
            companyId: clean(row[1]),
            cardholderId: clean(row[2]),
            hierarchyNode: clean(row[3]),
            firstName: clean(row[4]),
            lastName: clean(row[5]),
            email: clean(row[18]),
            employeeId: clean(row[22]),
            middleName: clean(row[24])
        };
    }

    function parseCardTransaction(row, lineNumber) {
        var transactionTypeCode = clean(row[17]);
        var billingAmount = centsToNumber(row[14]);
        var sourceAmount = centsToNumber(row[13]);
        var taxAmount = centsToNumber(row[20]);

        return {
            lineNumber: lineNumber,
            accountNumber: clean(row[1]),
            postingDate: parseVcfDate(row[2]),
            postingDateRaw: clean(row[2]),
            transactionReferenceNumber: clean(row[3]),
            sequenceNumber: clean(row[4]),
            period: clean(row[5]),
            acquiringBin: clean(row[6]),
            cardAcceptorId: clean(row[7]),
            supplierName: clean(row[8]),
            supplierCity: clean(row[9]),
            supplierStateProvinceCode: clean(row[10]),
            supplierIsoCountryCode: clean(row[11]),
            supplierPostalCode: clean(row[12]),
            sourceAmount: signedNumber(sourceAmount, transactionTypeCode),
            billingAmount: signedNumber(billingAmount, transactionTypeCode),
            sourceCurrencyCode: toIsoCurrency(row[15]),
            merchantCategoryCode: clean(row[16]),
            transactionTypeCode: transactionTypeCode,
            transactionTypeLabel: transactionTypeLabel(transactionTypeCode),
            transactionDate: parseVcfDate(row[18]),
            transactionDateRaw: clean(row[18]),
            billingCurrencyCode: toIsoCurrency(row[19]),
            taxAmount: signedNumber(taxAmount, transactionTypeCode),
            purchaseIdentification: clean(row[32]),
            authorizationNumber: clean(row[48]),
            statementDate: parseVcfDate(row[52]),
            userData1: clean(row[53]),
            userData2: clean(row[55]),
            userData3: clean(row[57]),
            userData4: clean(row[59]),
            userData5: clean(row[61])
        };
    }

    function toNetSuiteTransaction(transaction, account, cardholder) {
        var transactionDate = transaction.transactionDate || transaction.postingDate;
        var payee = transaction.supplierName || transaction.transactionTypeLabel || 'Commercial Card';
        var expenseCode = expenseCodeForMcc(transaction.merchantCategoryCode);
        var uniqueId = [
            accountLinkingId(transaction.accountNumber, account),
            transaction.postingDateRaw,
            transaction.transactionReferenceNumber,
            transaction.sequenceNumber
        ].join('|');

        return {
            id: uniqueId,
            uniqueId: uniqueId,
            date: transactionDate,
            amount: roundMoney(transaction.billingAmount),
            currency: transaction.sourceCurrencyCode || transaction.billingCurrencyCode,
            payee: payee,
            memo: buildMemo(transaction, account, cardholder),
            transactionTypeCode: isCredit(transaction.transactionTypeCode) ? 'CREDIT' : 'CHARGE',
            additionalFields: stringMap({
                billedCurrencyISOCode: transaction.billingCurrencyCode || transaction.sourceCurrencyCode,
                vcfMcc: transaction.merchantCategoryCode,
                vcfExpenseBucket: expenseCode,
                vcfTransactionTypeCode: transaction.transactionTypeCode,
                vcfTransactionTypeLabel: transaction.transactionTypeLabel,
                vcfCardholderId: account.cardholderId || '',
                vcfEmployeeId: cardholder.employeeId || '',
                vcfAccountLast4: lastFour(transaction.accountNumber),
                vcfPostingDate: transaction.postingDate,
                vcfSequenceNumber: transaction.sequenceNumber,
                vcfAuthorizationNumber: transaction.authorizationNumber,
                vcfPurchaseIdentification: transaction.purchaseIdentification,
                vcfCostCenter: account.costCenter || ''
            })
        };
    }

    function stringMap(values) {
        var result = {};
        var key;

        for (key in values) {
            if (values.hasOwnProperty(key) && values[key] !== null && values[key] !== undefined && values[key] !== '') {
                result[key] = String(values[key]);
            }
        }

        return result;
    }

    function accountLinkingId(accountNumber, account) {
        var candidate = clean(account && account.cardholderId);

        if (candidate && !/^[0-9]{13,19}$/.test(candidate)) {
            return candidate;
        }

        return externalAccountId(accountNumber);
    }

    function externalAccountId(accountNumber) {
        var value = clean(accountNumber);

        if (!value) {
            return 'VCF-UNKNOWN';
        }

        return 'VCF-' + lastFour(value) + '-' + stableHash(value);
    }

    function stableHash(value) {
        var hash = 2166136261;
        var i;

        for (i = 0; i < value.length; i += 1) {
            hash ^= value.charCodeAt(i);
            hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
        }

        return hash.toString(36).toUpperCase();
    }

    function splitRows(contents) {
        var normalized = String(contents || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        var lines = normalized.split('\n');
        var rows = [];
        var i;

        if (lines.length === 1 && normalized.indexOf('\t') !== -1) {
            return splitConcatenatedRows(normalized);
        }

        for (i = 0; i < lines.length; i += 1) {
            if (lines[i] !== '') {
                rows.push(lines[i].split('\t'));
            }
        }
        return rows;
    }

    function splitConcatenatedRows(contents) {
        var tokens = String(contents || '').split('\t');
        var rows = [];
        var index = 0;
        var pendingMarker = null;
        var currentBlockType = '';

        while (index < tokens.length || pendingMarker) {
            var marker = clean(pendingMarker || tokens[index]);
            var fieldCount;
            var row;

            if (!marker) {
                break;
            }

            if (marker === '6' || marker === '7' || marker === '8' || marker === '9') {
                row = takeConcatenatedRow(tokens, index, STRUCTURE_RECORD_FIELD_COUNT, pendingMarker);
                index = row.nextIndex;
                pendingMarker = row.pendingMarker;
                rows.push(row.fields);

                if (marker === '8') {
                    currentBlockType = clean(row.fields[4]);
                } else if (marker === '9') {
                    currentBlockType = '';
                }
                continue;
            }

            fieldCount = VCF_RECORD_FIELD_COUNTS[currentBlockType];
            if (!fieldCount) {
                break;
            }

            row = takeConcatenatedRow(tokens, index, fieldCount, pendingMarker);
            index = row.nextIndex;
            pendingMarker = row.pendingMarker;
            rows.push(row.fields);
        }

        return rows;
    }

    function takeConcatenatedRow(tokens, index, fieldCount, pendingMarker) {
        var fields = [];
        var lastField;
        var marker;

        if (pendingMarker) {
            fields.push(pendingMarker);
            pendingMarker = null;
        }

        while (fields.length < fieldCount && index < tokens.length) {
            fields.push(tokens[index]);
            index += 1;
        }

        if (fields.length < fieldCount) {
            throw new Error('Incomplete VCF record while splitting concatenated file.');
        }

        lastField = fields[fields.length - 1] || '';
        marker = lastField.charAt(lastField.length - 1);
        if (RECORD_BOUNDARY_MARKERS[marker]) {
            fields[fields.length - 1] = lastField.substr(0, lastField.length - 1);
            pendingMarker = marker;
        }

        return {
            fields: fields,
            nextIndex: index,
            pendingMarker: pendingMarker
        };
    }

    function isBlankRow(row) {
        var i;
        for (i = 0; i < row.length; i += 1) {
            if (clean(row[i]) !== '') {
                return false;
            }
        }
        return true;
    }

    function objectCount(values) {
        var count = 0;
        var key;

        for (key in values) {
            if (values.hasOwnProperty(key)) {
                count += 1;
            }
        }

        return count;
    }

    function addParserError(context, errorCode, lineNumber, characterOffset) {
        if (context && typeof context.addError === 'function') {
            context.addError({
                errorCode: errorCode,
                lineNumber: String(lineNumber || '1'),
                characterOffset: String(characterOffset || '1')
            });
        }
    }

    function createStandardError(errorCode) {
        if (nsError && typeof nsError.create === 'function') {
            return nsError.create({
                name: BANK_IMPORT_STANDARD_ERROR,
                message: errorCode
            });
        }

        var fallback = new Error(errorCode);
        fallback.name = BANK_IMPORT_STANDARD_ERROR;
        return fallback;
    }

    function logParserAudit(title, details) {
        if (log && typeof log.audit === 'function') {
            log.audit({
                title: title,
                details: stringify(details)
            });
        }
    }

    function logParserFailure(title, error) {
        if (log && typeof log.error === 'function') {
            log.error({
                title: title,
                details: stringify({
                    name: error && error.name,
                    message: error && error.message,
                    stack: error && error.stack
                })
            });
        }
    }

    function stringify(value) {
        try {
            return JSON.stringify(value);
        } catch (e) {
            return String(value);
        }
    }

    function clean(value) {
        if (value === null || value === undefined) {
            return '';
        }
        return String(value).replace(/^\uFEFF/, '').replace(/^\s+|\s+$/g, '');
    }

    function parseVcfDate(value) {
        var text = clean(value);
        if (!text || text === '0' || /^0+$/.test(text)) {
            return '';
        }
        if (/^\d{8}$/.test(text)) {
            return text.substr(4, 4) + '-' + text.substr(0, 2) + '-' + text.substr(2, 2);
        }
        return text;
    }

    function centsToNumber(value) {
        var text = clean(value);
        if (!text) {
            return 0;
        }
        if (!/^-?\d+$/.test(text)) {
            return 0;
        }
        return parseInt(text, 10) / 100;
    }

    function signedNumber(value, transactionTypeCode) {
        var amount = Number(value || 0);
        if (isCredit(transactionTypeCode) && amount > 0) {
            amount = amount * -1;
        }
        return amount;
    }

    function roundMoney(value) {
        return Math.round(Number(value || 0) * 100) / 100;
    }

    function calculateExchangeRate(sourceAmount, billingAmount) {
        var source = Math.abs(Number(sourceAmount || 0));
        var billing = Math.abs(Number(billingAmount || 0));
        if (!source || !billing) {
            return 1;
        }
        return Math.round((billing / source) * 100000000) / 100000000;
    }

    function toIsoCurrency(value) {
        var text = clean(value).toUpperCase();
        if (ISO_NUMERIC_TO_ALPHA[text]) {
            return ISO_NUMERIC_TO_ALPHA[text];
        }
        if (/^\d{1,3}$/.test(text)) {
            var padded = ('000' + text).slice(-3);
            if (ISO_NUMERIC_TO_ALPHA[padded]) {
                return ISO_NUMERIC_TO_ALPHA[padded];
            }
        }
        return text;
    }

    function isCredit(transactionTypeCode) {
        return CREDIT_TRANSACTION_TYPES[clean(transactionTypeCode)] === true;
    }

    function transactionTypeLabel(code) {
        var labels = {
            '10': 'Purchase',
            '11': 'Credit Voucher',
            '20': 'Manual Cash Disbursement',
            '22': 'ATM Cash Disbursement',
            '30': 'Payment Reversal - NSF Check',
            '31': 'Payment',
            '40': 'Finance Charge',
            '50': 'Annual Fee',
            '52': 'Miscellaneous Fees',
            '54': 'NSF Check Fee',
            '56': 'Report Fee',
            '61': 'Credit Adjustment',
            '62': 'Debit Adjustment',
            '63': 'Finance Charge Credit Adjustment',
            '64': 'Finance Charge Debit Adjustment',
            '65': 'Other Credits',
            '66': 'Other Debits',
            '71': 'Fuel Discount',
            '73': 'Non-Fuel Discount',
            '80': 'Convenience Checks',
            '82': 'Convenience Checks Fees',
            '84': 'Travelers Checks Fees',
            '86': 'ATM Fees',
            '88': 'Late Fees'
        };
        return labels[clean(code)] || '';
    }

    function expenseCodeForMcc(mcc) {
        var code = clean(mcc);
        var number = parseInt(code, 10);

        if (!code || isNaN(number)) {
            return 'VCF_MISC';
        }
        if ((number >= 3000 && number <= 3299) || (number >= 4511 && number <= 4582)) {
            return 'VCF_AIR';
        }
        if ((number >= 3300 && number <= 3499) || number === 7512 || number === 7513 || number === 7519) {
            return 'VCF_AUTO';
        }
        if (number === 5541 || number === 5542 || number === 5983 || number === 5172) {
            return 'VCF_FUEL';
        }
        if ((number >= 3500 && number <= 3999) || number === 7011 || number === 7012) {
            return 'VCF_LODGING';
        }
        if (number === 5811 || number === 5812 || number === 5813 || number === 5814) {
            return 'VCF_MEALS';
        }
        if (number === 5021 || number === 5044 || number === 5045 || number === 5111 || number === 5137 || number === 5943) {
            return 'VCF_OFFICE';
        }
        if ((number >= 7300 && number <= 7399) || number === 8111 || number === 8211 || number === 8220 || number === 8999) {
            return 'VCF_PROFESSIONAL';
        }
        if (number === 4214 || number === 4215 || number === 4411 || number === 4468) {
            return 'VCF_SHIPPING';
        }
        if ((number >= 4800 && number <= 4899) || number === 4900) {
            return 'VCF_TELECOM';
        }
        if ((number >= 5200 && number <= 5999) || number === 7999) {
            return 'VCF_RETAIL';
        }
        return 'VCF_MISC';
    }

    function buildCardHolderName(cardholder) {
        var parts = [];
        if (cardholder.firstName) {
            parts.push(cardholder.firstName);
        }
        if (cardholder.middleName) {
            parts.push(cardholder.middleName);
        }
        if (cardholder.lastName) {
            parts.push(cardholder.lastName);
        }
        return parts.join(' ');
    }

    function buildMemo(transaction, account, cardholder) {
        var parts = [];
        if (transaction.supplierName) {
            parts.push(transaction.supplierName);
        }
        if (transaction.supplierCity) {
            parts.push(transaction.supplierCity);
        }
        if (transaction.supplierStateProvinceCode) {
            parts.push(transaction.supplierStateProvinceCode);
        }
        if (transaction.merchantCategoryCode) {
            parts.push('MCC ' + transaction.merchantCategoryCode);
        }
        if (transaction.transactionTypeLabel) {
            parts.push(transaction.transactionTypeLabel);
        }
        if (account.costCenter) {
            parts.push(account.costCenter);
        }
        if (cardholder.email) {
            parts.push(cardholder.email);
        }
        return parts.join(' | ');
    }

    function lastFour(value) {
        var text = clean(value);
        if (text.length <= 4) {
            return text;
        }
        return text.substr(text.length - 4);
    }

    return {
        parseData: parseData,
        getExpenseCodes: getExpenseCodes,
        getStandardTransactionCodes: getStandardTransactionCodes
    };
});
