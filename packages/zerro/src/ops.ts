// Edits of the Zerro model: budgets, goals, envelope settings.
//
// Builders (setBudgets, setGoal, patchMeta) take the mirror and return a ZenMoney diff; nothing is
// sent. The apply* functions are complete operations over a Context: resolve the envelope,
// validate, and write safely — sync first (so a month's budgets, edited in Zerro meanwhile, are
// not overwritten with a stale copy), build, push, then fetch the server's copy of the Zerro data
// and check it holds what was written. With { dryRun: true } they only build the diff.
import type { DatabaseSync } from "node:sqlite";
import {
    applyDiff,
    db,
    fetchEntities,
    push,
    sync,
    ZmError,
    type Context,
    type Diff,
} from "@tihonove/zenmoney";
import { getEnvelopes, loadState, type Envelope } from "./envelopes.ts";
import { makeGoal } from "./goals.ts";
import { isMonth, mergeDiffs, readModel, STORES, writeData, type Model } from "./store.ts";
import {
    GOAL_TYPES,
    type EnvelopeId,
    type EnvelopeMeta,
    type Goal,
    type Month,
    type Visibility,
} from "./types.ts";

function fail(message: string): never {
    throw new ZmError(message);
}

function checkMonth(month: Month): Month {
    return isMonth(month) ? month : fail(`bad month '${month}', want YYYY-MM`);
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Find an envelope by id ("tag#…") or by name: exact first, then case-insensitive. Must be unique. */
export function resolveEnvelope(con: DatabaseSync, key: string): Envelope {
    const { byId } = getEnvelopes(loadState(con));
    const byIdMatch = byId[key as EnvelopeId];
    if (byIdMatch) return byIdMatch;

    const list = Object.values(byId);
    let found = list.filter((e) => e.name === key);
    if (found.length === 0) {
        const wanted = key.trim().toLowerCase();
        found = list.filter((e) => e.name.toLowerCase() === wanted);
    }
    if (found.length === 1) return found[0]!;
    if (found.length === 0) fail(`envelope not found: '${key}'`);
    return fail(`ambiguous envelope '${key}': ${found.map((e) => e.id).join(", ")}`);
}

// -------------------------------------------------------------------------------- builders

/** Budget amounts to set in a month: {envelope id: amount}; 0 removes the budget. */
export function setBudgets(
    con: DatabaseSync,
    month: Month,
    amounts: Record<EnvelopeId, number>,
): Diff {
    const stored = { ...readModel(con).budgets[checkMonth(month)] };
    for (const [id, value] of Object.entries(amounts) as [EnvelopeId, number][]) {
        if (value) stored[id] = value;
        else delete stored[id];
    }
    return writeData(con, STORES.budgets, stored, month);
}

/** The budgeted amount of an envelope in a month (Zerro's own budgets). */
export function budgetOf(model: Model, month: Month, id: EnvelopeId): number {
    return model.budgets[month]?.[id] ?? 0;
}

/**
 * Set (or with null, stop) an envelope's goal from `month` on — Zerro's setGoal: a new goal
 * also removes the nearest "stop" marker after it, unless another goal is set before that.
 */
export function setGoal(
    con: DatabaseSync,
    month: Month,
    id: EnvelopeId,
    draft: Partial<Goal> | null,
): Diff {
    const goals = readModel(con).goals;
    const goal = makeGoal(draft);
    const diffs = [
        writeData(con, STORES.goals, { ...goals[checkMonth(month)], [id]: goal }, month),
    ];

    if (goal) {
        const later = Object.keys(goals)
            .sort()
            .filter((m) => m > month);
        for (const m of later) {
            const value = goals[m]![id];
            if (value === null) {
                const rest = { ...goals[m] };
                delete rest[id];
                diffs.push(writeData(con, STORES.goals, rest, m));
                break;
            }
            if (value) break;
        }
    }
    return mergeDiffs(...diffs);
}

export type MetaPatch = Partial<Omit<EnvelopeMeta, "id">>;

/** Settings with a patch applied. Fields set to undefined disappear when stored (JSON). */
function mergeMeta(
    id: EnvelopeId,
    current: EnvelopeMeta | undefined,
    patch: MetaPatch,
): EnvelopeMeta {
    return { ...current, ...patch, id };
}

/** Change envelope settings; fields set to undefined are removed. */
export function patchMeta(con: DatabaseSync, patches: Record<EnvelopeId, MetaPatch>): Diff {
    const meta = { ...readModel(con).envelopeMeta };
    for (const [id, patch] of Object.entries(patches) as [EnvelopeId, MetaPatch][]) {
        meta[id] = mergeMeta(id, meta[id], patch);
    }
    return writeData(con, STORES.envelopeMeta, meta);
}

// ----------------------------------------------------------------------------- operations

/** The Zerro model as the server stores it right now (reminders and accounts fetched afresh). */
export async function serverModel(ctx: Context): Promise<Model> {
    // Stryker disable next-line StringLiteral: "" is a private temporary database in SQLite too
    const copy = db(":memory:");
    applyDiff(copy, await fetchEntities(ctx.remote, ["account", "reminder"]));
    return readModel(copy);
}

export interface WriteOptions {
    /** only build the diff from the mirror as it is: no sync, nothing sent */
    dryRun?: boolean;
}

/** An operation's result plus the diff it sent (or would send). */
export type Written<T> = T & { diff: Diff };

interface Plan<T> {
    diff: Diff;
    result: T;
    /** does the server's copy hold the result? */
    verify(model: Model): boolean;
}

async function write<T>(
    ctx: Context,
    plan: (con: DatabaseSync) => Plan<T>,
    { dryRun = false }: WriteOptions,
): Promise<Written<T>> {
    if (!dryRun) await sync(ctx.con, ctx.remote);
    const { diff, result, verify } = plan(ctx.con);
    if (!dryRun) {
        await push(ctx.con, ctx.remote, diff);
        if (!verify(await serverModel(ctx))) {
            fail("written, but the server copy differs — check in Zerro");
        }
    }
    return { ...result, diff };
}

/** Set an envelope's budget for a month, or with `add` change it by `amount`. 0 removes it. */
export async function applyBudget(
    ctx: Context,
    envelope: string,
    amount: number,
    month: Month,
    { add = false, ...options }: WriteOptions & { add?: boolean } = {},
): Promise<Written<{ id: EnvelopeId; month: Month; budgeted: number }>> {
    checkMonth(month);
    return write(
        ctx,
        (con) => {
            const id = resolveEnvelope(con, envelope).id;
            const current = add ? budgetOf(readModel(con), month, id) : 0;
            const budgeted = round(current + amount);
            return {
                diff: setBudgets(con, month, { [id]: budgeted }),
                result: { id, month, budgeted },
                verify: (m) => budgetOf(m, month, id) === budgeted,
            };
        },
        options,
    );
}

export interface MovedBudget {
    id: EnvelopeId;
    budgeted: number;
}

/** Move `amount` of a month's budget from one envelope to another. */
export async function applyMove(
    ctx: Context,
    amount: number,
    from: string,
    to: string,
    month: Month,
    options: WriteOptions = {},
): Promise<Written<{ month: Month; from: MovedBudget; to: MovedBudget }>> {
    checkMonth(month);
    return write(
        ctx,
        (con) => {
            const fromId = resolveEnvelope(con, from).id;
            const toId = resolveEnvelope(con, to).id;
            if (fromId === toId) fail("cannot move money to the same envelope");
            const model = readModel(con);
            const result = {
                month,
                from: { id: fromId, budgeted: round(budgetOf(model, month, fromId) - amount) },
                to: { id: toId, budgeted: round(budgetOf(model, month, toId) + amount) },
            };
            return {
                diff: setBudgets(con, month, {
                    [fromId]: result.from.budgeted,
                    [toId]: result.to.budgeted,
                }),
                result,
                verify: (m) =>
                    budgetOf(m, month, fromId) === result.from.budgeted &&
                    budgetOf(m, month, toId) === result.to.budgeted,
            };
        },
        options,
    );
}

/** A goal from a user: a known type, an amount, and for targetBalance an optional end month. */
function validGoal(goal: Partial<Goal>): Goal {
    const { type, amount, end } = goal;
    if (!type || !(GOAL_TYPES as readonly string[]).includes(type)) {
        fail(`goal type must be one of ${GOAL_TYPES.join(", ")}`);
    }
    if (!amount) fail("goal amount is required");
    if (end !== undefined && !/^\d{4}-\d{2}(-\d{2})?$/.test(end)) {
        fail(`bad goal end '${end}', want YYYY-MM`);
    }
    return makeGoal(goal)!;
}

/** Set an envelope's goal from `month` on; null stops it from that month. */
export async function applyGoal(
    ctx: Context,
    envelope: string,
    goal: Partial<Goal> | null,
    month: Month,
    options: WriteOptions = {},
): Promise<Written<{ id: EnvelopeId; month: Month; goal: Goal | null }>> {
    checkMonth(month);
    const valid = goal && validGoal(goal);
    return write(
        ctx,
        (con) => {
            const id = resolveEnvelope(con, envelope).id;
            return {
                diff: setGoal(con, month, id, valid),
                result: { id, month, goal: valid },
                verify: (m) => JSON.stringify(m.goals[month]?.[id]) === JSON.stringify(valid),
            };
        },
        options,
    );
}

const VISIBILITY: Visibility[] = ["hidden", "visible", "auto"];

/**
 * Change an envelope's settings. A field set to undefined is removed (back to Zerro's default);
 * a currency is upper-cased.
 */
export async function applyMeta(
    ctx: Context,
    envelope: string,
    patch: MetaPatch,
    options: WriteOptions = {},
): Promise<Written<{ id: EnvelopeId; meta: EnvelopeMeta }>> {
    if (Object.keys(patch).length === 0) fail("nothing to change");
    if (patch.visibility !== undefined && !VISIBILITY.includes(patch.visibility)) {
        fail(`visibility must be one of ${VISIBILITY.join(", ")}`);
    }
    const normalized = { ...patch };
    if (patch.currency) normalized.currency = patch.currency.toUpperCase();

    return write(
        ctx,
        (con) => {
            const id = resolveEnvelope(con, envelope).id;
            const meta = mergeMeta(id, readModel(con).envelopeMeta[id], normalized);
            return {
                diff: patchMeta(con, { [id]: normalized }),
                result: { id, meta },
                verify: (m) => JSON.stringify(m.envelopeMeta[id]) === JSON.stringify(meta),
            };
        },
        options,
    );
}
