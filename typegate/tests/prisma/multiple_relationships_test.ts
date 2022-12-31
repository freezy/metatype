// Copyright Metatype OÜ under the Elastic License 2.0 (ELv2). See LICENSE.md for usage.

import { gql, recreateMigrations, test } from "../utils.ts";

test("multiple relationships", async (t) => {
  const tgPath = "prisma/prisma_multi.py";
  const e = await t.pythonFile(tgPath);

  await t.should("drop schema and recreate", async () => {
    await gql`
      mutation a {
        executeRaw(
          query: "DROP SCHEMA IF EXISTS test CASCADE"
          parameters: "[]"
        )
      }
    `
      .expectData({
        executeRaw: 0,
      })
      .on(e);
    await recreateMigrations(e);
  });

  await t.should("insert a simple record", async () => {
    await gql`
      mutation q {
        createUser(data: { id: 12, name: "name", email: "email@example.com" }) {
          id
        }
      }
    `
      .expectData({
        createUser: { id: 12 },
      })
      .on(e);

    await gql`
      query {
        findUniqueUser(where: { id: 12 }) {
          id
          name
          email
          sentMessages {
            id
          }
          receivedMessages {
            id
          }
        }
      }
    `
      .expectData({
        findUniqueUser: {
          id: 12,
          name: "name",
          email: "email@example.com",
          sentMessages: [],
          receivedMessages: [],
        },
      })
      .on(e);
  });

  await t.should("create many nested fields", async () => {
    await gql`
      mutation {
        createUser(
          data: {
            id: 15
            name: "User 15"
            email: "user15@example.com"
            sentMessages: {
              create: {
                id: 234
                time: 23456
                message: "Hi"
                recipient: { connect: { id: 12 } }
              }
              # createMany: {
              #   data: [
              #     {
              #       id: 234
              #       time: 23456
              #       message: "Hi"
              #       # recipientId: 12
              #     },
              #     {
              #       id: 235
              #       time: 23467
              #       message: "Are you OK?"
              #       # recipientId: 12
              #     }
              #   ]
              # }
            }
          }
        ) {
          id
        }
      }
    `
      .expectData({
        createUser: {
          id: 15,
        },
      })
      .on(e);

    await gql`
      query {
        findMessages(where: { sender: { id: 15 } }) {
          id
          time
          message
        }
      }
    `
      .expectData({
        findMessages: [
          { id: 234, time: 23456, message: "Hi" },
          // { id: 235, time: 23467, message: "Are you OK?" },
        ],
      })
      .on(e);

    await gql`
      mutation {
        deleteMessages(where: { sender: { id: 15 } }) {
          count
        }
      }
    `
      .expectData({
        deleteMessages: {
          count: 1,
        },
      })
      .on(e);
  });

  await gql`
    mutation {
      updateUser(
        where: { id: 15 }
        data: {
          sentMessages: {
            create: {
              id: 345
              message: "Hi"
              time: 34567
              recipient: { connect: { id: 12 } }
            }
          }
        }
      ) {
        sentMessages {
          id
        }
      }
    }
  `
    .expectData({
      updateUser: {
        sentMessages: [{ id: 345 }],
      },
    })
    .on(e);
});
