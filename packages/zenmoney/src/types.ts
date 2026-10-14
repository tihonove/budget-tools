// ZenMoney API v8 entities, as they come from /v8/diff/.
// Based on ardov/zerro src/6-shared/types/data-entities.ts plus fields seen from the live API.
// Times are unix seconds, dates are "YYYY-MM-DD", amounts are in the entity's instrument.

export type UnixTime = number;
export type IsoDate = string;
export type UserId = number;
export type InstrumentId = number;
export type CompanyId = number;
export type AccountId = string;
export type TagId = string;
export type MerchantId = string;
export type ReminderId = string;
export type ReminderMarkerId = string;
export type TransactionId = string;

export interface Instrument {
    id: InstrumentId;
    changed: UnixTime;
    title: string;
    /** Currency code: "EUR", "RUB". */
    shortTitle: string;
    symbol: string;
    /** Rate to RUB. */
    rate: number;
}

export interface Company {
    id: CompanyId;
    changed: UnixTime;
    title: string;
    fullTitle: string | null;
    www: string | null;
    country: number | null;
    countryCode: string | null;
    deleted: boolean;
}

export interface User {
    id: UserId;
    changed: UnixTime;
    currency: InstrumentId;
    parent: UserId | null;
    country: number;
    countryCode: string;
    email: string | null;
    login: string | null;
    monthStartDay: number;
    isForecastEnabled: boolean;
    planBalanceMode: string;
    planSettings: string;
    paidTill: UnixTime;
    subscription: string;
    subscriptionRenewalDate: unknown;
}

export const ACCOUNT_TYPES = [
    "cash",
    "ccard",
    "checking",
    "loan",
    "deposit",
    "emoney",
    "debt",
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export interface Account {
    id: AccountId;
    changed: UnixTime;
    user: UserId;
    instrument: InstrumentId;
    title: string;
    role: number | null;
    company: CompanyId | null;
    type: AccountType;
    syncID: string[] | null;
    balance: number;
    /** For deposit and loan: the initial deposit / loan body. The server derives `balance` from it. */
    startBalance: number;
    creditLimit: number;
    inBalance: boolean;
    savings: boolean;
    enableCorrection: boolean;
    enableSMS: boolean;
    archive: boolean;
    private: boolean;
    capitalization: boolean | null;
    percent: number | null;
    startDate: IsoDate | null;
    endDateOffset: number | null;
    endDateOffsetInterval: "day" | "week" | "month" | "year" | null;
    payoffStep: number | null;
    payoffInterval: "month" | "year" | null;
    balanceCorrectionType?: string;
}

export interface Tag {
    id: TagId;
    changed: UnixTime;
    user: UserId;
    title: string;
    parent: TagId | null;
    icon: string | null;
    staticId: string | null;
    picture: string | null;
    color: number | null;
    showIncome: boolean;
    showOutcome: boolean;
    budgetIncome: boolean;
    budgetOutcome: boolean;
    required: boolean | null;
    archive?: boolean;
}

export interface Merchant {
    id: MerchantId;
    changed: UnixTime;
    user: UserId;
    title: string;
    mcc?: number | null;
}

export interface Budget {
    changed: UnixTime;
    user: UserId;
    /** null or "00000000-0000-0000-0000-000000000000" = all categories */
    tag: TagId | null;
    date: IsoDate;
    income: number;
    incomeLock: boolean;
    outcome: number;
    outcomeLock: boolean;
    isIncomeForecast?: boolean;
    isOutcomeForecast?: boolean;
}

export interface Reminder {
    id: ReminderId;
    changed: UnixTime;
    user: UserId;
    incomeInstrument: InstrumentId;
    incomeAccount: AccountId;
    income: number;
    outcomeInstrument: InstrumentId;
    outcomeAccount: AccountId;
    outcome: number;
    tag: TagId[] | null;
    merchant: MerchantId | null;
    payee: string | null;
    comment: string | null;
    interval: "day" | "week" | "month" | "year" | null;
    step: number | null;
    points: number[] | null;
    startDate: IsoDate;
    endDate: IsoDate | null;
    notify: boolean;
}

export interface ReminderMarker {
    id: ReminderMarkerId;
    changed: UnixTime;
    user: UserId;
    incomeInstrument: InstrumentId;
    incomeAccount: AccountId;
    income: number;
    outcomeInstrument: InstrumentId;
    outcomeAccount: AccountId;
    outcome: number;
    tag: TagId[] | null;
    merchant: MerchantId | null;
    payee: string | null;
    comment: string | null;
    date: IsoDate;
    reminder: ReminderId;
    state: "planned" | "processed" | "deleted";
    notify: boolean;
}

export interface Transaction {
    id: TransactionId;
    changed: UnixTime;
    created: UnixTime;
    user: UserId;
    deleted: boolean;
    hold: boolean | null;
    viewed?: boolean;
    qrCode: string | null;
    source?: string;
    incomeBankID: CompanyId | null;
    incomeInstrument: InstrumentId;
    incomeAccount: AccountId;
    income: number;
    outcomeBankID: CompanyId | null;
    outcomeInstrument: InstrumentId;
    outcomeAccount: AccountId;
    outcome: number;
    tag: TagId[] | null;
    merchant: MerchantId | null;
    payee: string | null;
    originalPayee: string | null;
    comment: string | null;
    date: IsoDate;
    mcc: number | null;
    reminderMarker: ReminderMarkerId | null;
    opIncome: number | null;
    opIncomeInstrument: InstrumentId | null;
    opOutcome: number | null;
    opOutcomeInstrument: InstrumentId | null;
    latitude: number | null;
    longitude: number | null;
}

/** Entity name → object type. */
export interface Entities {
    instrument: Instrument;
    company: Company;
    user: User;
    account: Account;
    tag: Tag;
    merchant: Merchant;
    budget: Budget;
    reminder: Reminder;
    reminderMarker: ReminderMarker;
    transaction: Transaction;
}
export type EntityName = keyof Entities;

export const ENTITIES: readonly EntityName[] = [
    "instrument",
    "company",
    "user",
    "account",
    "tag",
    "merchant",
    "budget",
    "reminder",
    "reminderMarker",
    "transaction",
];

export interface Deletion {
    id: string | number;
    object: EntityName;
    stamp: UnixTime;
    user: UserId;
}

/** A /v8/diff/ payload or response: entity arrays and deletions. */
export type Diff = { [E in EntityName]?: Entities[E][] } & {
    deletion?: Deletion[];
    serverTimestamp?: UnixTime;
};
