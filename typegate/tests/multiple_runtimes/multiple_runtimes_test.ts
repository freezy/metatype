// Copyright Metatype OÜ under the Elastic License 2.0 (ELv2). See LICENSE.md for usage.

import { gql, recreateMigrations, removeMigrations, test } from "../utils.ts";

test("prisma", async (t) => {
  const tgPath = "multiple_runtimes/multiple_runtimes.py";
  const e = await t.pythonFile(tgPath);

  function sql(q: string, res: any = 0) {
    return gql`
      mutation a($sql: String) {
        executeRaw(
          query: $sql
          parameters: "[]"
        )
      }
    `
      .withVars({ sql: q })
      .expectData({ executeRaw: res });
  }

  await t.should("drop schemas and recreate", async () => {
    await sql("DROP SCHEMA IF EXISTS test CASCADE").on(e);
    await sql("DROP SCHEMA IF EXISTS test2 CASCADE").on(e);
    await removeMigrations(e);
    await recreateMigrations(e);
  });

  await t.should("succeed queries", async () => {
    await gql`
      mutation {
        createUser1(data: { name: "user" }) {
          id
          name
        }
      }
    `
      .expectData({
        createUser1: {
          id: 1,
          name: "user",
        },
      })
      .on(e);

    await gql`
      query {
        findManyUsers1 {
          id
          name
        }
      }
    `
      .expectData({
        findManyUsers1: [{ id: 1, name: "user" }],
      })
      .on(e);

    await gql`
      query {
        findManyUsers2 {
          id
          name
        }
      }
    `
      .expectData({
        findManyUsers2: [],
      })
      .on(e);
  });
});