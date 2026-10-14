// Builders and edits for ZenMoney objects. They only return objects to push;
// sending is up to the caller (push() from store.ts, or a dry run).
import type { DatabaseSync } from "node:sqlite";
import { fail, load, now, resolve, resolveInstrument, user, uuid } from "./store.ts";
import {
    ACCOUNT_TYPES,
    type Account,
    type AccountType,
    type Tag,
    type Transaction,
} from "./types.ts";

const loadTransaction = (con: DatabaseSync, id: string): Transaction =>
    load(con, "transaction", id) ?? fail(`not found ${id}`);

const isTransfer = (t: Transaction): boolean => t.income > 0 && t.outcome > 0;

// --------------------------------------------------------------------------- transactions

export type TransactionKind = "expense" | "income" | "transfer";

export interface NewTransaction {
    kind?: TransactionKind | string;
    /** account title or id */
    account: string;
    amount: number | string;
    /** YYYY-MM-DD */
    date: string;
    /** transfers: the receiving account */
    to_account?: string | undefined;
    /** transfers between currencies: the received amount */
    to_amount?: number | string | undefined;
    /** category titles or ids */
    tag?: string[] | undefined;
    payee?: string | undefined;
    comment?: string | undefined;
}

export function newTransaction(con: DatabaseSync, input: NewTransaction): Transaction {
    const { kind = "expense", account, date, to_account, to_amount, tag, payee, comment } = input;
    if (!account || input.amount == null || !date) fail("transaction needs account, amount, date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`bad date '${date}', want YYYY-MM-DD`);

    const source = resolve(con, "account", account);
    const time = now();
    const amount = Number(input.amount);
    const tx: Transaction = {
        id: uuid(),
        changed: time,
        created: time,
        user: user(con).id,
        deleted: false,
        hold: null,
        viewed: false,
        qrCode: null,
        incomeInstrument: source.instrument,
        incomeAccount: source.id,
        income: 0,
        incomeBankID: null,
        outcomeInstrument: source.instrument,
        outcomeAccount: source.id,
        outcome: 0,
        outcomeBankID: null,
        opIncome: null,
        opIncomeInstrument: null,
        opOutcome: null,
        opOutcomeInstrument: null,
        tag: tag?.length ? tag.map((t) => resolve(con, "tag", t).id) : null,
        merchant: null,
        payee: payee ?? null,
        originalPayee: null,
        comment: comment ?? null,
        date,
        mcc: null,
        latitude: null,
        longitude: null,
        reminderMarker: null,
    };

    if (kind === "expense") {
        tx.outcome = amount;
    } else if (kind === "income") {
        tx.income = amount;
    } else if (kind === "transfer") {
        if (!to_account) fail("transfer needs --to-account");
        const target = resolve(con, "account", to_account);
        tx.outcome = amount;
        tx.incomeAccount = target.id;
        tx.incomeInstrument = target.instrument;
        tx.income = to_amount != null ? Number(to_amount) : amount;
    } else {
        fail(`bad kind '${kind}'`);
    }
    return tx;
}

export interface TransactionPatch {
    /** replaces categories; empty strings are dropped, nothing left = no category */
    tag?: string[] | undefined;
    /** "" clears */
    payee?: string | undefined;
    /** "" clears */
    comment?: string | undefined;
    date?: string | undefined;
    amount?: number | undefined;
    /** expenses and incomes only */
    account?: string | undefined;
}

export function updateTransactions(
    con: DatabaseSync,
    ids: string[],
    patch: TransactionPatch,
): Transaction[] {
    return ids.map((id) => {
        const tx = loadTransaction(con, id);
        if (patch.tag) {
            const tags = patch.tag.filter(Boolean);
            tx.tag = tags.length ? tags.map((t) => resolve(con, "tag", t).id) : null;
        }
        if (patch.payee != null) tx.payee = patch.payee || null;
        if (patch.comment != null) tx.comment = patch.comment || null;
        if (patch.date) tx.date = patch.date;
        if (patch.amount != null) {
            if (tx.outcome > 0) tx.outcome = patch.amount;
            if (tx.income > 0) tx.income = patch.amount;
        }
        if (patch.account) {
            if (isTransfer(tx)) fail("for transfers edit the JSON and use `zm push`");
            const account = resolve(con, "account", patch.account);
            tx.outcomeAccount = tx.incomeAccount = account.id;
            tx.outcomeInstrument = tx.incomeInstrument = account.instrument;
        }
        tx.changed = now();
        return tx;
    });
}

/**
 * Turn expenses / incomes into transfers with `account` on the other side:
 * an expense becomes "this account → account", an income "account → this account".
 * The amount is copied as is, so both sides must share a currency.
 */
export function toTransfers(con: DatabaseSync, ids: string[], account: string): Transaction[] {
    const other = resolve(con, "account", account);
    return ids.map((id) => {
        const tx = loadTransaction(con, id);
        if (isTransfer(tx)) fail(`${id} is already a transfer`);
        if (tx.outcome > 0) {
            tx.incomeAccount = other.id;
            tx.incomeInstrument = other.instrument;
            tx.income = tx.outcome;
        } else {
            tx.outcomeAccount = other.id;
            tx.outcomeInstrument = other.instrument;
            tx.outcome = tx.income;
        }
        if (tx.incomeInstrument !== tx.outcomeInstrument)
            fail(`${id}: currencies differ, use zm push`);
        tx.changed = now();
        return tx;
    });
}

/** Mark as deleted (the server keeps them with deleted=true). */
export function softDeleteTransactions(con: DatabaseSync, ids: string[]): Transaction[] {
    return ids.map((id) => ({ ...loadTransaction(con, id), deleted: true, changed: now() }));
}

// ---------------------------------------------------------------------------------- tags

export interface NewTag {
    title: string;
    /** parent title or id */
    parent?: string | undefined;
    income?: boolean;
    outcome?: boolean;
}

export function newTag(
    con: DatabaseSync,
    { title, parent, income = true, outcome = true }: NewTag,
): Tag {
    return {
        id: uuid(),
        changed: now(),
        user: user(con).id,
        title,
        parent: parent ? resolve(con, "tag", parent).id : null,
        icon: null,
        picture: null,
        color: null,
        showIncome: income,
        showOutcome: outcome,
        budgetIncome: income,
        budgetOutcome: outcome,
        required: null,
        staticId: null,
    };
}

export interface TagPatch {
    title?: string | undefined;
    /** "" makes it top-level */
    parent?: string | undefined;
    income?: boolean | undefined;
    outcome?: boolean | undefined;
}

export function updateTag(con: DatabaseSync, key: string, patch: TagPatch): Tag {
    const tag = resolve(con, "tag", key);
    if (patch.title) tag.title = patch.title;
    if (patch.parent != null)
        tag.parent = patch.parent ? resolve(con, "tag", patch.parent).id : null;
    if (patch.income != null) tag.showIncome = tag.budgetIncome = patch.income;
    if (patch.outcome != null) tag.showOutcome = tag.budgetOutcome = patch.outcome;
    tag.changed = now();
    return tag;
}

// ------------------------------------------------------------------------------ accounts

export interface NewAccount {
    title: string;
    type?: AccountType | string | undefined;
    /** code, symbol or id */
    currency: string;
    balance?: number | undefined;
    in_balance?: boolean | undefined;
    savings?: boolean | undefined;
    credit_limit?: number | undefined;
}

export function newAccount(con: DatabaseSync, input: NewAccount): Account {
    const {
        title,
        type = "ccard",
        currency,
        balance = 0,
        in_balance = true,
        savings = false,
        credit_limit = 0,
    } = input;
    if (!(ACCOUNT_TYPES as readonly string[]).includes(type)) {
        fail(`bad type '${type}', one of ${ACCOUNT_TYPES.join(", ")}`);
    }
    return {
        id: uuid(),
        changed: now(),
        user: user(con).id,
        role: null,
        instrument: resolveInstrument(con, currency).id,
        company: null,
        type: type as AccountType,
        title,
        syncID: null,
        balance,
        // A credit card's balance is not its start balance: the server would add them up.
        startBalance: type === "ccard" ? 0 : balance,
        creditLimit: credit_limit,
        inBalance: in_balance,
        savings,
        enableCorrection: true,
        balanceCorrectionType: "request",
        enableSMS: false,
        archive: false,
        private: false,
        capitalization: null,
        percent: null,
        startDate: null,
        endDateOffset: null,
        endDateOffsetInterval: null,
        payoffStep: null,
        payoffInterval: null,
    };
}

export interface AccountPatch {
    title?: string | undefined;
    balance?: number | undefined;
    archive?: boolean | undefined;
    in_balance?: boolean | undefined;
    savings?: boolean | undefined;
}

export function updateAccount(con: DatabaseSync, key: string, patch: AccountPatch): Account {
    const account = resolve(con, "account", key);
    if (patch.title) account.title = patch.title;
    if (patch.balance != null) {
        // The server derives balance from startBalance, so shift startBalance by the same delta.
        account.startBalance =
            Number(account.startBalance ?? 0) + (patch.balance - Number(account.balance ?? 0));
        account.balance = patch.balance;
    }
    if (patch.archive != null) account.archive = patch.archive;
    if (patch.in_balance != null) account.inBalance = patch.in_balance;
    if (patch.savings != null) account.savings = patch.savings;
    account.changed = now();
    return account;
}
