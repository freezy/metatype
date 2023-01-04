from typegraph.graphs.typegraph import TypeGraph
from typegraph.materializers.deno import FunMat
from typegraph.materializers.http import HTTPRuntime
from typegraph.policies import Policy
from typegraph.types import types as t

with TypeGraph("swagger-petstore") as g:

    remote = HTTPRuntime("https://petstore.swagger.io/v2")

    allow_all = Policy(FunMat("() => true")).named("allow_all_policy")

    category = t.struct(
        {
            "id": t.integer(),
            "name": t.string(),
        }
    ).named("Category")

    # status = t.enum([t.literal("available"), t.literal("pending"), t.literal("sold")])
    # status = t.enum(["available", "pending", "sold"])
    status = t.string()

    pet = t.struct(
        {
            "id": t.optional(t.integer()),
            "category": t.optional(g("Category")),
            "name": t.string(),
            "photoUrls": t.array(t.string()),
            "tags": t.optional(t.array(g("Tag"))),
            "status": t.optional(status),
        }
    ).named("Pet")

    tag = t.struct({"id": t.integer(), "name": t.string()}).named("Tag")

    find_pet_by_id = remote.get(
        "/pet/{id}", t.struct({"id": t.integer()}), t.optional(g("Pet"))
    ).add_policy(allow_all)

    find_pets_by_status = remote.get(
        "/pet/findByStatus", t.struct({"status": status}), t.array(g("Pet"))
    ).add_policy(allow_all)

    find_pets_by_tags = remote.get(
        "/pet/findByTags", t.struct({"tags": t.array(t.string())}), t.array(g("Pet"))
    ).add_policy(allow_all)

    add_pet = remote.post("/pet", g("Pet"), g("Pet")).add_policy(allow_all)

    update_pet = remote.put("/pet", g("Pet"), g("Pet")).add_policy(allow_all)

    update_pet_with_form = remote.post(
        "/pet/{petId}",
        t.struct({"petId": t.integer(), "name": t.string(), "status": t.string()}),
        g("Pet"),
        content_type="application/x-www-form-urlencoded",
    ).add_policy(allow_all)

    g.expose(
        pet=find_pet_by_id,
        petsByStatus=find_pets_by_status,
        petsByTags=find_pets_by_tags,
        addPet=add_pet,
        updatePet=update_pet,
        updatePetWithForm=update_pet_with_form,
    )