import { gql, shell, test } from "./utils.ts";

test("prisma", async (t) => {
  const e = await t.pythonFile("./tests/typegraphs/prisma.py");

  await t.should("drop schema and recreate", async () => {
    await gql`
      mutation a {
        queryRaw(query: "DROP SCHEMA IF EXISTS test CASCADE", parameters: "[]")
      }
    `
      .expectData({
        queryRaw: [],
      })
      .on(e);
    await shell(["../typegraph/.venv/bin/meta", "prisma", "apply"]);
  });

  await t.should("return no data when empty", async () => {
    await gql`
      query {
        findManyrecord {
          id
        }
      }
    `
      .expectData({
        findManyrecord: [],
      })
      .on(e);
  });

  await t.should("insert a simple message", async () => {
    const id = "b7831fd1-799d-4b20-9a84-830588f750af";
    await gql`
      mutation {
        createOnerecord(
          data: {
            id: ${id}
            name: "name"
            age: 1
          }
        ) {
          id
        }
      }
    `
      .expectData({
        createOnerecord: { id },
      })
      .on(e);
  });

  await t.should("refuse to insert if not unique", async () => {
    const id = "b7831fd1-799d-4b20-9a84-830588f750ae";
    const q = gql`
    mutation {
      createOnerecord(
        data: {
          id: ${id}
          name: "name"
          age: 1
        }
      ) {
        id
      }
    }
  `;
    await q
      .expectData({
        createOnerecord: { id },
      })
      .on(e);

    await q
      .expectErrorContains("Unique constraint failed on the fields: (`id`)")
      .on(e);
  });
});
