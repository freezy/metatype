// Copyright Metatype OÜ under the Elastic License 2.0 (ELv2). See LICENSE.md for usage.

import { gql, test } from "../utils.ts";

test(
  "Union type",
  async (t) => {
    const e = await t.pythonFile("type_nodes/union_node_quantifier.py");

    await t.should("work with optionals and list arguments", async () => {
      await gql`
          query {
            registerPhone(
              phone: {
                name: "LG",
                battery: 5000,
                metadatas: [
                  {label: "IMEI", content: "1234567891011", source: "Factory1234"},
                  {label: "ref", content: "LG_1234"},
                ]
              }
            ) {
              message
              type
              phone {
                name
                metadatas {
                  label
                  content
                  source
                }
              }
            }
          }
        `
        .expectData({
          registerPhone: {
            message: "LG registered",
            type: "Basic",
            phone: {
              name: "LG",
              metadatas: [
                {
                  label: "IMEI",
                  content: "1234567891011",
                  source: "Factory1234",
                },
                {
                  label: "ref",
                  content: "LG_1234",
                },
              ],
            },
          },
        })
        .on(e);
    });

    await t.should("work with optional field completed", async () => {
      await gql`
        query {
          registerPhone(
            phone: {
              name: "SAMSUNG",
              camera: 50,
              battery: 5000,
              os: "Android"
            }
          ) {
            message
            type
            phone {
              name
              os
            }
          }
        }
      `
        .expectData({
          registerPhone: {
            message: "SAMSUNG registered",
            type: "Smartphone",
            phone: {
              name: "SAMSUNG",
              os: "Android",
            },
          },
        })
        .on(e);
    });
  },
  { introspection: true },
);