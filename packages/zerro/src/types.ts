// Zerro's model as stored inside ZenMoney. Mirrors src/5-entities/{envelope,goal,budget} in ardov/zerro.

/** "YYYY-MM" */
export type Month = string;

export const ENV_TYPES = ["tag", "account", "merchant", "payee"] as const;
export type EnvType = (typeof ENV_TYPES)[number];

/** "tag#<tag id>", "account#<account id>", "merchant#<merchant id>", "payee#<clean payee>" */
export type EnvelopeId = `${EnvType}#${string}`;

export type Visibility = "hidden" | "visible" | "auto";

/** Per-envelope settings, stored in one EnvelopeMeta reminder for all envelopes. */
export interface EnvelopeMeta {
    id: EnvelopeId;
    group?: string;
    index?: number;
    visibility?: Visibility;
    parent?: EnvelopeId;
    comment?: string;
    /** currency code; default: the user's currency */
    currency?: string;
    /** income in this envelope stays in it instead of going to "to be budgeted" */
    keepIncome?: boolean;
    /** a negative balance carries over to the next month instead of being reset */
    carryNegatives?: boolean;
}

export const GOAL_TYPES = ["monthly", "monthlySpend", "targetBalance", "incomePercent"] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

/**
 * monthly        — put `amount` into the envelope every month;
 * monthlySpend   — have `amount` available every month (leftover counts);
 * targetBalance  — reach `amount` in the envelope, by `end` (YYYY-MM-DD) if given;
 * incomePercent  — put `amount` (0..1) of the month's income into the envelope.
 */
export interface Goal {
    type: GoalType;
    amount: number;
    end?: string;
}

/** {month: {envelope: amount budgeted}} */
export type Budgets = Record<Month, Record<EnvelopeId, number>>;
/** {month: {envelope: goal set from this month on; null stops an earlier goal}} */
export type Goals = Record<Month, Record<EnvelopeId, Goal | null>>;

export interface FxRatesMonth {
    date?: Month;
    changed?: number;
    rates: Record<string, number>;
}

export interface UserSettings {
    sawMigrationAlert?: boolean;
    /** use ZenMoney's own budgets for categories */
    preferZmBudgets?: boolean;
    emojiIcons?: boolean;
}
