// Zerro's envelopes: a data snapshot from the mirror, the envelope list and its tree, budgets.
// Mirrors src/5-entities/{envelope,account,debtors,budget} in ardov/zerro.
import type { DatabaseSync } from "node:sqlite";
import {
    all,
    user,
    type Account,
    type Budget,
    type Instrument,
    type Merchant,
    type Tag,
    type Transaction,
} from "@tihonove/zenmoney";
import { DATA_ACC_NAME, readModel, type Model } from "./store.ts";
import type { Budgets, EnvelopeId, EnvelopeMeta, EnvType, Visibility } from "./types.ts";

export const NULL_TAG = "null";
/** Zerro's default group names (en locale). */
export const GROUPS: Record<EnvType, string> = {
    tag: "Categories",
    account: "Transfers",
    merchant: "Debts",
    payee: "Debts",
};
const TYPE_RANK: Record<EnvType, number> = { tag: 0, account: 1, merchant: 2, payee: 3 };

export const envId = (type: EnvType, id: string): EnvelopeId => `${type}#${id}`;

export function parseEnvId(id: string): { type: string; id: string } {
    const i = id.indexOf("#");
    return { type: id.slice(0, i), id: id.slice(i + 1) };
}

/** Zerro's cleanPayee: only digits, latin and cyrillic letters, lower case. */
export const cleanPayee = (name: string): string =>
    name.replace(/[^\d\wа-яА-ЯёЁ]/g, "").toLowerCase();

/** Zerro's isDeleted() negated: deleted or empty transactions don't count. */
const isLive = (t: Transaction): boolean =>
    !t.deleted && (t.income >= 0.0001 || t.outcome >= 0.0001);

/** In the budget: not a debt account, and counted in the balance (or marked with 📍). */
export const isInBudget = (a: Account): boolean =>
    a.type !== "debt" && (a.title.endsWith("📍") || a.inBalance);

/** Everything the calculation needs, read once from the mirror. */
export interface State {
    userFx: string;
    instruments: Record<number, Instrument>;
    accounts: Account[];
    tags: Tag[];
    merchants: Record<string, Merchant>;
    zmBudgets: Budget[];
    /** live transactions, oldest first */
    transactions: Transaction[];
    model: Model;
}

export function loadState(con: DatabaseSync): State {
    const owner = user(con);
    const instruments = Object.fromEntries(all(con, "instrument").map((i) => [i.id, i]));
    const byTime = (a: Transaction, b: Transaction) =>
        a.date.localeCompare(b.date) || a.created - b.created;
    return {
        userFx: instruments[owner.currency]?.shortTitle ?? "EUR",
        instruments,
        accounts: all(con, "account"),
        tags: all(con, "tag"),
        merchants: Object.fromEntries(all(con, "merchant").map((m) => [m.id, m])),
        zmBudgets: all(con, "budget"),
        transactions: all(con, "transaction").filter(isLive).sort(byTime),
        model: readModel(con),
    };
}

export const debtAccountId = (s: State): string | undefined =>
    s.accounts.find((a) => a.type === "debt")?.id;

export type TrType = "income" | "outcome" | "transfer" | "incomeDebt" | "outcomeDebt";

/** Zerro's trModel.getType(). */
export function trType(t: Transaction, debtId?: string): TrType {
    if (debtId && t.incomeAccount === debtId) return "outcomeDebt";
    if (debtId && t.outcomeAccount === debtId) return "incomeDebt";
    if (t.income && t.outcome) return "transfer";
    if (t.outcome) return "outcome";
    return "income";
}

export interface Debtor {
    name: string;
    merchantId?: string;
}

/**
 * Debtors from debt transactions, by clean name (Zerro's getDebtors). A merchant joins the debtor
 * with the same clean name; the first name seen stays.
 */
export function getDebtors(s: State): Map<string, Debtor> {
    const debtId = debtAccountId(s);
    const debtors = new Map<string, Debtor>();
    for (const t of s.transactions) {
        const type = trType(t, debtId);
        if (type !== "incomeDebt" && type !== "outcomeDebt") continue;
        const name = t.merchant ? (s.merchants[t.merchant]?.title ?? t.merchant) : t.payee;
        if (!name) continue;
        const key = cleanPayee(name);
        const debtor = debtors.get(key) ?? { name };
        if (t.merchant) debtor.merchantId = t.merchant;
        debtors.set(key, debtor);
    }
    return debtors;
}

/**
 * The envelope a transaction belongs to (rawActivity.getEnvelope). A debt with a payee goes to
 * its debtor's merchant envelope when the debtor has one.
 */
export function envelopeOf(
    t: Transaction,
    /** money leaves the budget through this transaction */
    outgoing: boolean,
    debtId: string | undefined,
    debtors: Map<string, Debtor>,
): EnvelopeId {
    const type = trType(t, debtId);
    if (type === "income" || type === "outcome") return envId("tag", t.tag?.[0] || NULL_TAG);
    if (type === "transfer") return envId("account", outgoing ? t.incomeAccount : t.outcomeAccount);
    if (t.merchant) return envId("merchant", t.merchant);
    const clean = cleanPayee(String(t.payee));
    const merchantId = debtors.get(clean)?.merchantId;
    return merchantId ? envId("merchant", merchantId) : envId("payee", clean);
}

export interface Envelope {
    id: EnvelopeId;
    type: EnvType;
    name: string;
    parent: EnvelopeId | null;
    children: EnvelopeId[];
    /** position from settings, if any */
    indexRaw: number | undefined;
    /** display position */
    index: number;
    group: string;
    comment: string;
    visibility: Visibility;
    currency: string;
    keepIncome: boolean;
    carryNegatives: boolean;
}

/** Zerro's order: by saved index (indexed first), then type, "no category" first, then name. */
function compareEnvelopes(a: Envelope, b: Envelope): number {
    const index = (e: Envelope) => e.indexRaw ?? Number.MAX_SAFE_INTEGER;
    const isNull = (e: Envelope) => (e.id === envId("tag", NULL_TAG) ? 0 : 1);
    return (
        index(a) - index(b) ||
        TYPE_RANK[a.type] - TYPE_RANK[b.type] ||
        isNull(a) - isNull(b) ||
        a.name.localeCompare(b.name)
    );
}

export interface Group {
    name: string;
    /** top-level envelopes in display order; children are in Envelope.children */
    envelopes: EnvelopeId[];
}

/**
 * All envelopes: categories (plus "no category"), accounts out of the budget, debtors.
 * Zerro's structure is applied: two levels at most, children follow their parent's group,
 * `index` is the display order.
 */
export function getEnvelopes(s: State): { byId: Record<EnvelopeId, Envelope>; groups: Group[] } {
    const meta = s.model.envelopeMeta;
    const byId: Record<EnvelopeId, Envelope> = {};

    const add = (
        type: EnvType,
        entityId: string,
        name: string,
        tagParent: EnvelopeId | null,
        shown = false,
    ) => {
        const id = envId(type, entityId);
        const m: Partial<EnvelopeMeta> = meta[id] ?? {};
        byId[id] = {
            id,
            type,
            name,
            parent: type === "tag" ? tagParent : (m.parent ?? null),
            children: [],
            indexRaw: m.index,
            index: 0,
            group: m.group || GROUPS[type],
            comment: m.comment || "",
            visibility: m.visibility || (shown ? "visible" : "auto"),
            currency: m.currency || s.userFx,
            keepIncome: m.keepIncome || false,
            carryNegatives: m.carryNegatives || false,
        };
    };

    add("tag", NULL_TAG, "Uncategorized", null);
    for (const t of s.tags)
        add("tag", t.id, t.title, t.parent ? envId("tag", t.parent) : null, t.showOutcome);
    for (const a of s.accounts) {
        if (!isInBudget(a) && a.type !== "debt" && a.title !== DATA_ACC_NAME)
            add("account", a.id, a.title, null);
    }
    for (const [clean, d] of getDebtors(s)) {
        if (d.merchantId) add("merchant", d.merchantId, d.name, null);
        else add("payee", clean, d.name, null);
    }

    // Flatten to the topmost existing parent (cycles have none).
    const topParent = (start: EnvelopeId | null): EnvelopeId | null => {
        const seen = new Set<EnvelopeId>();
        let id = start;
        while (id && byId[id]) {
            const up = byId[id]!.parent;
            if (!up) return id;
            if (seen.has(id)) return null;
            seen.add(id);
            id = up;
        }
        return null;
    };
    const sorted = Object.values(byId).sort(compareEnvelopes);
    // Computed from the original links first, so the result does not depend on the order.
    const tops = sorted.map((e) => topParent(e.parent));
    sorted.forEach((e, i) => (e.parent = tops[i]!));

    const groups: Group[] = [];
    for (const e of sorted) {
        if (e.parent) {
            byId[e.parent]!.children.push(e.id);
            continue;
        }
        let group = groups.find((g) => g.name === e.group);
        if (!group) groups.push((group = { name: e.group, envelopes: [] }));
        group.envelopes.push(e.id);
    }

    let index = 0;
    for (const g of groups) {
        for (const id of g.envelopes) {
            const e = byId[id]!;
            e.index = index++;
            for (const child of e.children) {
                byId[child]!.group = g.name;
                byId[child]!.index = index++;
            }
        }
    }
    return { byId, groups };
}

/** Budgets by month: Zerro's own, or ZenMoney's for categories if preferZmBudgets is on. */
export function getBudgets(s: State): Budgets {
    const preferZm = !!s.model.userSettings.preferZmBudgets;
    const result: Budgets = {};
    const put = (month: string, id: EnvelopeId, value: number) =>
        ((result[month] ??= {})[id] = value);

    if (preferZm) {
        for (const b of s.zmBudgets)
            if (b.outcome) put(b.date.slice(0, 7), envId("tag", String(b.tag)), b.outcome);
    }
    for (const [month, envelopes] of Object.entries(s.model.budgets)) {
        for (const [id, value] of Object.entries(envelopes) as [EnvelopeId, number][]) {
            if (!value || (preferZm && id.startsWith("tag#"))) continue;
            put(month, id, value);
        }
    }
    return result;
}
