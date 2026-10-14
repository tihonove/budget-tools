// Builders for small hand-made ZenMoney accounts used by the zerro tests.
import type { Account, Instrument, Reminder, Tag, Transaction, User } from "@tihonove/zenmoney";
import { DATA_ACC_NAME, readModel, type Model, type State } from "@tihonove/zerro";
import { memoryMirror } from "@tihonove/testing";

export const instruments: Instrument[] = [
    { id: 1, changed: 1, title: "US dollar", shortTitle: "USD", symbol: "$", rate: 90 },
    { id: 2, changed: 1, title: "Russian ruble", shortTitle: "RUB", symbol: "₽", rate: 1 },
    { id: 3, changed: 1, title: "Euro", shortTitle: "EUR", symbol: "€", rate: 100 },
];

export const me: User = {
    id: 1,
    changed: 1,
    currency: 3,
    parent: null,
    country: 1,
    countryCode: "NL",
    email: null,
    login: "test",
    monthStartDay: 1,
    isForecastEnabled: false,
    planBalanceMode: "balance",
    planSettings: "",
    paidTill: 0,
    subscription: "",
    subscriptionRenewalDate: null,
};

export function account(id: string, title: string, o: Partial<Account> = {}): Account {
    return {
        id,
        changed: 1,
        user: 1,
        instrument: 3,
        title,
        role: null,
        company: null,
        type: "ccard",
        syncID: null,
        balance: 0,
        startBalance: 0,
        creditLimit: 0,
        inBalance: true,
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
        ...o,
    };
}

export function tag(id: string, title: string, o: Partial<Tag> = {}): Tag {
    return {
        id,
        changed: 1,
        user: 1,
        title,
        parent: null,
        icon: null,
        staticId: null,
        picture: null,
        color: null,
        showIncome: true,
        showOutcome: true,
        budgetIncome: true,
        budgetOutcome: true,
        required: null,
        ...o,
    };
}

let created = 0;
/** An expense of `amount` on `acc` (EUR card by default); pass income/incomeAccount for others. */
export function tx(id: string, date: string, o: Partial<Transaction> = {}): Transaction {
    return {
        id,
        changed: 1,
        created: ++created,
        user: 1,
        deleted: false,
        hold: null,
        qrCode: null,
        incomeBankID: null,
        incomeInstrument: 3,
        incomeAccount: "eur",
        income: 0,
        outcomeBankID: null,
        outcomeInstrument: 3,
        outcomeAccount: "eur",
        outcome: 0,
        tag: null,
        merchant: null,
        payee: null,
        originalPayee: null,
        comment: null,
        date,
        mcc: null,
        reminderMarker: null,
        opIncome: null,
        opIncomeInstrument: null,
        opOutcome: null,
        opOutcomeInstrument: null,
        latitude: null,
        longitude: null,
        ...o,
    };
}

/** A Zerro data reminder with this comment payload. */
export function reminder(id: string, data: unknown, o: Partial<Reminder> = {}): Reminder {
    return {
        id,
        changed: 1,
        user: 1,
        incomeInstrument: 3,
        incomeAccount: "zerro",
        income: 1,
        outcomeInstrument: 3,
        outcomeAccount: "zerro",
        outcome: 0,
        tag: null,
        merchant: null,
        payee: null,
        comment: typeof data === "string" ? data : JSON.stringify(data),
        interval: null,
        step: 0,
        points: [0],
        startDate: "2020-01-01",
        endDate: "2020-01-01",
        notify: false,
        ...o,
    };
}

export const dataAcc = account("zerro", DATA_ACC_NAME, { type: "cash", inBalance: false });

export const baseTags = [
    tag("food", "Groceries"),
    tag("fun", "Hobbies"),
    tag("cafe", "Dining", { parent: "fun" }),
    tag("salary", "Bonus", { showOutcome: false }),
];

export function emptyModel(): Model {
    return readModel(memoryMirror({ account: [], reminder: [] }));
}

/** A State for calc tests: EUR user, one EUR card ("eur", in budget) unless accounts are given. */
export function state(o: Omit<Partial<State>, "model"> & { model?: Partial<Model> } = {}): State {
    return {
        userFx: "EUR",
        instruments: Object.fromEntries(instruments.map((i) => [i.id, i])),
        accounts: [account("eur", "Card €")],
        tags: baseTags,
        merchants: {},
        zmBudgets: [],
        transactions: [],
        ...o,
        model: { ...emptyModel(), ...o.model },
    };
}
