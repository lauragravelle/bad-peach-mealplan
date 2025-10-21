// /api/mealplan.js — Vercel serverless function (Node 18+)

export const config = { runtime: "nodejs" };

import fs from "node:fs/promises";
import path from "node:path";

function selectByIds(all, ids){ const set = new Set(ids); return all.filter(r => set.has(r.id)); }

const schema = {
  name: "MealPlan",
  schema: {
    type: "object",
    properties: {
      week_plan: {
        type: "array",
        items: {
          type: "object",
          properties: {
            day: { type: "integer" },
            meals: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  recipe_id: { type: "string" },
                  target_cal: { type: "integer" },
                  target_protein_g: { type: "integer" },
                  scaled_ingredients: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        ingredient: { type: "string" },
                        amount_g: { type: "number" },
                        amount_cups: { type: "number" }
                      },
                      required: ["ingredient","amount_g","amount_cups"]
                    }
                  },
                  directions: { type: "array", items: { type: "string" } }
                },
                required: ["name","recipe_id","target_cal","target_protein_g","scaled_ingredients"]
              }
            }
          },
          required: ["day","meals"]
        }
      },
      grocery_list: {
        type: "array",
        items: {
          type: "object",
          properties: {
            store_section: { type: "string" },
            items: { type: "array", items: { type: "string" } }
          },
          required: ["store_section","items"]
        }
      },
      batch_prep: { type: "array", items: { type: "string" } }
    },
    required: ["week_plan","grocery_list","batch_prep"]
  }
};

export default async function handler(req, res){
  try{
    if(req.method !== "POST"){ return res.status(405).json({error:"POST only"}); }

    const body = await readJson(req);
    const { caloriesPerDay, proteinPerDay, mealsPerDay, store, repetition, selected } = body || {};

    // load recipe catalog
    const file = path.join(process.cwd(), "data", "recipes.json");
    const allRecipes = JSON.parse(await fs.readFile(file, "utf8"));

    // only pass the recipes the user picked
    const picked = [
      ...selectByIds(allRecipes, selected?.breakfast || []),
      ...selectByIds(allRecipes, selected?.snack || []),
      ...selectByIds(allRecipes, selected?.dinner || [])
    ];

    if(!caloriesPerDay || !proteinPerDay) return res.status(400).json({error:"Missing calories/protein"});
    if(![3,4].includes(mealsPerDay))      return res.status(400).json({error:"mealsPerDay must be 3 or 4"});
    if(!picked.length)                    return res.status(400).json({error:"No recipes selected"});

    // your ChatGPT prompt logic
    const system = `
You are a meal-plan generator that outputs ONLY valid JSON per the provided schema.

Non-negotiables:
- Build a 7-day plan that hits daily targets: ${caloriesPerDay} kcal and ${proteinPerDay} g protein.
- Use exactly ${mealsPerDay} meals per day.
- Lunch is always leftovers from the previous dinner; do not invent new lunch recipes.
- Use ONLY the recipes provided (no new recipes).
- Respect repetition caps: breakfast=${repetition?.breakfast||0}, snack=${repetition?.snack||0}, dinner=${repetition?.dinner||0}.
- If mealsPerDay=3, ignore snack entirely.
- The grocery list MUST be customized to the user's preferred store: ${store}.
  • For each ingredient, suggest likely BRAND and PACKAGE SIZE in parentheses.
  • Keep ingredients aligned with the recipes’ healthy defaults (e.g., "nonfat", "unsweetened").
  • Do NOT change the recipes—only brand/package suggestions in the grocery list.
- Organize grocery_list by store sections (Produce, Dairy, Frozen, Meat/Seafood, Pantry, Bakery, Spices, Canned, Other).
- Mediterranean-forward; no added oil; list scaled ingredients with grams AND cups.
- Keep each meal near its targets; daily totals within ±5%.
- Return STRICT JSON only (no commentary).
`.trim();

    const user = `
Candidate recipes with ingredients as provided (titles/wording unchanged):
${JSON.stringify(picked)}

Return a 7-day plan using only these recipes (no extras). Conform EXACTLY to the JSON schema.
`.trim();

    // call OpenAI Responses API
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5",
        input: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        response_format: { type: "json_schema", json_schema: schema }
      })
    });

    if(!resp.ok){
      const txt = await resp.text();
      return res.status(500).json({error:"OpenAI error", detail:txt});
    }
    const data = await resp.json();
    const text = data?.output?.[0]?.content?.[0]?.text;
    const json = JSON.parse(text);

    return res.status(200).json(json);
  }catch(e){
    return res.status(500).json({error:"Meal plan generation failed."});
  }
}

function readJson(req){
  return new Promise(resolve=>{
    let buf=""; req.on("data",d=>buf+=d);
    req.on("end",()=>{ try{ resolve(JSON.parse(buf||"{}")); }catch{ resolve({}); }});
  });
}
