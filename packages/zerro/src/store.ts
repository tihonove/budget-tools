// Zerro's hidden storage inside ZenMoney (src/5-entities/shared/hidden-store in ardov/zerro).
//
// Zerro keeps its model in reminders attached to a helper account "🤖 [Zerro Data]".
// Each reminder's `comment` is JSON:
//   monthly stores: {type, month: "YYYY-MM", payload}   — budgets, goals, fxRates
//   simple stores:  {type, payload}                     — EnvelopeMeta, UserSettings, tagOrder, ...
// Writing an empty payload to a monthly store deletes that month's reminder.
import type { DatabaseSync } from "node:sqlite";
import {
    all,
    deletion,
    now,
    user,
    uuid,
    type Account,
    type Diff,
    type Reminder,
} from "@tihonove/zenmoney";
import type {
    Budgets,
    EnvelopeId,
    EnvelopeMeta,
    FxRatesMonth,
    Goals,
    Month,
    UserSettings,
} from "./types.ts";

export const DATA_ACC_NAME = "🤖 [Zerro Data]";

export const STORES = {
    budgets: "budgets",
    goals: "goals",
    fxRates: "fxRates",
    envelopeMeta: "EnvelopeMeta",
    userSettings: "UserSettings",
} as const;

const MONTHLY: readonly string[] = [STORES.budgets, STORES.goals, STORES.fxRates];

export const isMonth = (m: unknown): m is Month => typeof m === "string" && /^\d{4}-\d{2}$/.test(m);

interface Stored {
    type: string;
    month?: Month;
    payload: unknown;
}

/** The stored JSON, or null if the comment is not an object with a `type`. */
function parseComment(comment: string | null): Stored | null {
    try {
        // `in` throws on null and primitives: those are not Zerro data either.
        const data = JSON.parse(String(comment)) as object;
        if ("type" in data) return data as Stored;
    } catch {
        // not JSON
    }
    return null;
}

export const dataAccount = (con: DatabaseSync): Account | null =>
    all(con, "account").find((a) => a.title === DATA_ACC_NAME) ?? null;

export interface DataReminder extends Stored {
    reminder: Reminder;
}

/** All Zerro data reminders. Like Zerro, they are recognized by their comment, on any account. */
export function dataReminders(con: DatabaseSync): DataReminder[] {
    const found: DataReminder[] = [];
    for (const reminder of all(con, "reminder")) {
        const data = parseComment(reminder.comment);
        if (!data) continue;
        if (MONTHLY.includes(data.type) && !isMonth(data.month)) continue;
        found.push({ ...data, reminder });
    }
    return found;
}

export interface Model {
    dataAccount: Account | null;
    budgets: Budgets;
    goals: Goals;
    fxRates: Record<Month, FxRatesMonth>;
    envelopeMeta: Record<EnvelopeId, EnvelopeMeta>;
    userSettings: UserSettings;
    /** other stores (tagOrder, linkedAccounts, ...): kept as is */
    other: Record<string, unknown>;
}

/** The whole Zerro model from the mirror. */
export function readModel(con: DatabaseSync): Model {
    const model: Model = {
        dataAccount: dataAccount(con),
        budgets: {},
        goals: {},
        fxRates: {},
        envelopeMeta: {},
        userSettings: {},
        other: {},
    };
    for (const d of dataReminders(con)) {
        const payload = (d.payload ?? {}) as never;
        if (d.type === STORES.budgets) model.budgets[d.month!] = payload;
        else if (d.type === STORES.goals) model.goals[d.month!] = payload;
        else if (d.type === STORES.fxRates) model.fxRates[d.month!] = payload;
        else if (d.type === STORES.envelopeMeta) model.envelopeMeta = payload;
        else if (d.type === STORES.userSettings) model.userSettings = payload;
        else model.other[d.type] = d.payload;
    }
    return model;
}

/** Zerro's accountModel.makeAccount defaults for the helper account. */
function makeDataAccount(con: DatabaseSync): Account {
    const owner = user(con);
    return {
        id: uuid(),
        changed: now(),
        user: owner.id,
        instrument: owner.currency,
        title: DATA_ACC_NAME,
        role: null,
        company: null,
        type: "cash",
        syncID: null,
        balance: 0,
        startBalance: 0,
        creditLimit: 0,
        inBalance: false,
        savings: false,
        enableCorrection: false,
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

/** Zerro's makeReminder for a data reminder: a fake one-off reminder dated 2020-01-01. */
function makeReminder(
    con: DatabaseSync,
    accountId: string,
    existing: Reminder | undefined,
    comment: string,
): Reminder {
    const owner = user(con);
    return {
        ...existing,
        id: existing?.id ?? uuid(),
        changed: now(),
        user: existing?.user ?? owner.id,
        incomeAccount: accountId,
        outcomeAccount: accountId,
        incomeInstrument: existing?.incomeInstrument ?? owner.currency,
        outcomeInstrument: existing?.outcomeInstrument ?? owner.currency,
        income: 1,
        outcome: 0,
        tag: null,
        merchant: null,
        payee: null,
        comment,
        interval: null,
        step: 0,
        points: [0],
        startDate: "2020-01-01",
        endDate: "2020-01-01",
        notify: false,
    };
}

const isEmpty = (payload: object | null | undefined): boolean =>
    Object.keys(payload ?? {}).length === 0;

/**
 * A diff that writes `payload` to a store (and `month` for monthly stores). Updates the existing
 * reminder, or creates one — and the helper account if missing. An empty monthly payload deletes
 * that month's reminder.
 */
export function writeData(
    con: DatabaseSync,
    type: string,
    payload: object | null | undefined,
    month?: Month,
): Diff {
    const monthly = MONTHLY.includes(type);
    if (monthly && !isMonth(month)) throw new Error(`month required for ${type}, got '${month}'`);
    const existing = dataReminders(con).find(
        (d) => d.type === type && d.month === (monthly ? month : undefined),
    );

    if (monthly && isEmpty(payload)) {
        return existing ? { deletion: deletion(con, "reminder", [existing.reminder.id]) } : {};
    }

    const diff: Diff = {};
    let account = dataAccount(con);
    if (!account) {
        account = makeDataAccount(con);
        diff.account = [account];
    }
    const comment = JSON.stringify(monthly ? { type, month, payload } : { type, payload });
    const accountId = existing?.reminder.incomeAccount ?? account.id;
    diff.reminder = [makeReminder(con, accountId, existing?.reminder, comment)];
    return diff;
}

/** Merge diffs from writeData into one; the helper account is created once. */
export function mergeDiffs(...diffs: Diff[]): Diff {
    const merged: Diff = {};
    for (const d of diffs) {
        if (d.account && !merged.account) merged.account = d.account;
        if (d.reminder) merged.reminder = [...(merged.reminder ?? []), ...d.reminder];
        if (d.deletion) merged.deletion = [...(merged.deletion ?? []), ...d.deletion];
    }
    return merged;
}
