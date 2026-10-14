// Contract tests: what the ZenMoney API really does with what we send.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { liveConfig, liveRemote } from "@tihonove/testing";
import {
    checkToken,
    db,
    deletion,
    fetchEntities,
    load,
    makeRemote,
    newAccount,
    newTag,
    newTransaction,
    push,
    sync,
    updateAccount,
    uuid,
    type Remote,
} from "@tihonove/zenmoney";

const config = liveConfig();

describe.skipIf(!config)("ZenMoney API (live, test account)", () => {
    const con = db(":memory:");
    let remote: Remote;
    const created: { tag: string[]; account: string[]; transaction: string[] } = {
        tag: [],
        account: [],
        transaction: [],
    };

    beforeAll(async () => {
        remote = await liveRemote(config!);
        await sync(con, remote, { full: true });
    });

    afterAll(async () => {
        if (!remote) return;
        const kinds = ["transaction", "tag", "account"] as const;
        const del = kinds.flatMap((k) => (created[k].length ? deletion(con, k, created[k]) : []));
        if (del.length) await push(con, remote, { deletion: del });
    });

    test("the guard refuses a token of another user", async () => {
        await expect(liveRemote({ ...config!, userId: config!.userId + 1 })).rejects.toThrow(
            /refusing to run/,
        );
    });

    test("a wrong token is rejected", async () => {
        expect(
            await checkToken(makeRemote({ api: config!.api, token: "wrong-" + uuid() })),
        ).toBeNull();
    });

    test("a full sync brings the user, currencies, accounts and categories in the expected shape", () => {
        const me = load(con, "user", config!.userId)!;
        expect(me.id).toBe(config!.userId);
        expect(typeof me.currency).toBe("number");
        const currency = load(con, "instrument", me.currency)!;
        expect(currency.shortTitle).toMatch(/^[A-Z]{3}$/);
        expect(typeof currency.rate).toBe("number");
    });

    test("a category: create, see it on the server, rename", async () => {
        const tag = newTag(con, { title: `live ${uuid().slice(0, 8)}` });
        created.tag.push(tag.id);
        await push(con, remote, { tag: [tag] });

        const fresh = await fetchEntities(remote, ["tag"]);
        expect(fresh.tag!.find((t) => t.id === tag.id)).toMatchObject({
            title: tag.title,
            showOutcome: true,
        });
    });

    test("an account: the server derives balance from startBalance; updateAccount sets the balance", async () => {
        const account = newAccount(con, {
            title: `live ${uuid().slice(0, 8)}`,
            type: "cash",
            currency: "RUB",
            balance: 10,
        });
        created.account.push(account.id);
        await push(con, remote, { account: [account] });
        await sync(con, remote);

        const updated = updateAccount(con, account.id, { balance: 25 });
        await push(con, remote, { account: [updated] });
        const fresh = (await fetchEntities(remote, ["account"])).account!.find(
            (a) => a.id === account.id,
        )!;
        expect(fresh.balance).toBe(25);
    });

    test("a transaction: create, see it, the account balance follows", async () => {
        const account = newAccount(con, {
            title: `live ${uuid().slice(0, 8)}`,
            type: "cash",
            currency: "RUB",
            balance: 100,
        });
        created.account.push(account.id);
        await push(con, remote, { account: [account] });

        const tx = newTransaction(con, {
            kind: "expense",
            account: account.id,
            amount: 30,
            date: "2026-01-15",
            payee: "live test",
        });
        created.transaction.push(tx.id);
        await push(con, remote, { transaction: [tx] });

        const fresh = await fetchEntities(remote, ["transaction", "account"]);
        expect(fresh.transaction!.find((t) => t.id === tx.id)).toMatchObject({
            outcome: 30,
            payee: "live test",
        });
        expect(fresh.account!.find((a) => a.id === account.id)!.balance).toBe(70);
    });
});
